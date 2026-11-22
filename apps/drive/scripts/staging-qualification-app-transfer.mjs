import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { qualificationPrefix } from './staging-qualification.mjs';
import { largeBytes, verifyQualificationDownload, verifyQualificationLargeDownload } from './staging-qualification-large-transfer.mjs';
import { probeQualificationWorker } from './staging-qualification-worker.mjs';

const partBytes = 16 * 1024 ** 2;
const interruptionPart = 64; // One GiB acknowledged; a full and a short part remain.
const resumeBytes = (interruptionPart + 1) * partBytes + 257;
const uploads = '/api/uploads';
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const unverified = () => new Error('Qualification app transfer is unverified.');
const json = { 'content-type': 'application/json' };
const binary = { 'content-type': 'application/octet-stream' };
const discard = response => { void response?.body?.cancel().catch(() => {}); };

async function readReply(response, status, signal, limit = 4096) {
  if (signal.aborted || response?.status !== status || response.redirected || !response.body ||
      response.headers.has('content-encoding') || response.headers.get('content-type')?.split(';', 1)[0] !== json['content-type']) {
    discard(response);
    throw unverified();
  }
  const reader = response.body.getReader(), bytes = new Uint8Array(limit);
  let cancellation, offset = 0, ended = false;
  const cancel = () => { cancellation ??= reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) { ended = true; return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))); }
      if (!(value instanceof Uint8Array) || !value.length || offset + value.length > limit) throw unverified();
      bytes.set(value, offset);
      offset += value.length;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!ended) cancel();
    // Release the reader even while the transport's cleanup is pending.
    reader.releaseLock();
  }
}

const partSize = (size, number) => Math.min(partBytes, size - (number - 1) * partBytes);
function fixturePart(size, number, seed, buffer) {
  const bytes = buffer.subarray(0, partSize(size, number));
  bytes.fill(seed[(number - 1) % seed.length]);
  bytes.writeUInt32BE(number);
  return bytes;
}

async function planFixture(size, seed, signal) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(partBytes), expectedParts = [];
  for (let number = 1; number <= Math.ceil(size / partBytes); number++) {
    await setImmediate(undefined, { signal });
    const bytes = fixturePart(size, number, seed, buffer);
    hash.update(bytes);
    expectedParts.push(Object.freeze({ partNumber: number, sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') }));
  }
  return { digest: hash.digest('hex'), expectedParts: Object.freeze(expectedParts) };
}

function send(request, signal, path, method, body, headers) {
  signal.throwIfAborted();
  return request(path, { method, body, headers, signal, redirect: 'error', cache: 'no-store' });
}

async function sendParts(request, signal, path, size, seed, first, last) {
  const buffer = Buffer.allocUnsafe(partBytes);
  for (let n = first; n <= last; n++) {
    const response = await send(request, signal, `${path}/parts/${n}`, 'PUT', fixturePart(size, n, seed, buffer), binary);
    discard(response);
    signal.throwIfAborted();
    if (response?.status !== 204 || response.redirected || response.body !== null) throw unverified();
  }
}

async function completeAndDownload(request, signal, path, name) {
  const completion = await send(request, signal, `${path}/complete`, 'POST', JSON.stringify({ parentId: null, name }), json);
  const { id } = await readReply(completion, 201, signal);
  if (!isUuid(id)) throw unverified();
  return send(request, signal, `/api/download/${id}`, 'GET');
}

async function open(scope, signal, openClient, revokedMemberId, principalId = null, intentId = null) {
  signal.throwIfAborted();
  const client = await openClient(scope, signal, Object.freeze({ principalId, intentId }));
  const { scope: bound, principalId: member, role, intentId: intent, request } = client ?? {};
  if (!isUuid(member) || member === revokedMemberId || role !== 'member' ||
      (principalId !== null && member !== principalId) || intent !== intentId || typeof request !== 'function' ||
      Object.keys(scope).some(key => bound?.[key] !== scope[key])) throw unverified();
  const boundRequest = request.bind(client);
  await probeQualificationWorker(scope, signal, async (url, init) => {
    const response = await boundRequest(new URL(url).pathname, init);
    if (response?.body !== null || response.redirected) {
      discard(response);
      throw unverified();
    }
    return response;
  });
  return { principalId: member, request: boundRequest };
}

async function exercise(context, signal, openClient, revokedMemberId, size, interruption) {
  try {
    const { sha, version, runId, attempt, prefix } = context;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha) || !isUuid(version) ||
        prefix !== qualificationPrefix({ runId, attempt }) || !isUuid(revokedMemberId)) throw unverified();
    const scope = Object.freeze({ sha, version, runId, attempt, prefix });
    const stop = new AbortController();
    const resumable = interruption !== null;
    const initial = resumable ? AbortSignal.any([signal, stop.signal]) : signal;
    const client = await open(scope, initial, openClient, revokedMemberId);
    let { request } = client;

    const name = `qualification-${runId}-${attempt}-${resumable ? 'resume' : 'large'}.bin`;
    const seed = createHash('sha256').update(`${sha}/${version}/${prefix}${name}`).digest();
    const { digest, expectedParts } = await planFixture(size, seed, initial);
    const expectedPartSha256s = expectedParts.map(part => part.sha256).join('');
    const allocation = await send(request, initial, uploads, 'POST', JSON.stringify({ size, expectedPartSha256s }), json);
    const { id } = await readReply(allocation, 201, initial);
    if (!isUuid(id)) throw unverified();
    const path = `${uploads}/${id}`;

    // A lost acknowledgement throws before the client can reopen.
    await sendParts(request, initial, path, size, seed, 1, interruption ?? expectedParts.length);
    if (resumable) {
      stop.abort();
      ({ request } = await open(scope, signal, openClient, revokedMemberId, client.principalId, id));
      const evidence = await readReply(await send(request, signal, `${path}/resume`, 'GET'), 200, signal, 64 * 1024);
      if (evidence?.declaredSize !== size || evidence.expectedPartSha256s !== expectedPartSha256s ||
          !Array.isArray(evidence.parts) || evidence.parts.length !== interruption ||
          !evidence.parts.every((part, i) => part?.partNumber === expectedParts[i].partNumber &&
            part.sizeBytes === expectedParts[i].sizeBytes && part.sha256 === expectedParts[i].sha256)) throw unverified();
      await sendParts(request, signal, path, size, seed, interruption + 1, expectedParts.length);
    }
    const download = await completeAndDownload(request, signal, path, name);
    if (!resumable) return await verifyQualificationLargeDownload(download, digest, signal);
    await verifyQualificationDownload(download, size, digest, signal);
    return { 'interrupted-transfer-resume': 'pass' };
  } catch {
    throw unverified();
  }
}

// Unwired. The factory vouches for the immutable candidate's scope, including the
// run/attempt bindings that enforce the allocation prefix, and authenticates an
// active, dedicated invitee. Reopen authenticates that member for the original
// intent. The same candidate-bound transport serves readiness and app requests.
// Requests are same-origin, abortable, non-retrying, and drain upload bodies before settling.
export const exerciseQualificationLargeTransfer = (context, signal, openClient, revokedMemberId) =>
  exercise(context, signal, openClient, revokedMemberId, largeBytes, null);
export const exerciseQualificationResume = (context, signal, openClient, revokedMemberId) =>
  exercise(context, signal, openClient, revokedMemberId, resumeBytes, interruptionPart);

// Two real-sized parts exercise the sealed HTTP contract in a disposable Worker.
export const exerciseQualificationResumeFixture = (context, signal, openClient, revokedMemberId) =>
  exercise(context, signal, openClient, revokedMemberId, partBytes + 257, 1);
