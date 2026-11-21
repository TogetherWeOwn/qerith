import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { qualificationPrefix } from './staging-qualification.mjs';
import { largeBytes, verifyQualificationDownload, verifyQualificationLargeDownload } from './staging-qualification-large-transfer.mjs';

const partBytes = 16 * 1024 ** 2;
const interruptionPart = 64; // One GiB acknowledged; a full and a short part remain.
const resumeBytes = (interruptionPart + 1) * partBytes + 257;
const uploads = '/api/uploads';
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const unverified = () => new Error('Qualification app transfer is unverified.');
const json = { 'content-type': 'application/json' };
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

function send(client, signal, path, method, body, headers) {
  signal.throwIfAborted();
  return client.request(path, { method, body, headers, signal, redirect: 'error', cache: 'no-store' });
}

async function sendParts(client, signal, path, size, seed, first, accepted = () => {}) {
  const buffer = Buffer.allocUnsafe(partBytes);
  for (let n = first; n <= Math.ceil(size / partBytes); n++) {
    const response = await send(client, signal, `${path}/parts/${n}`, 'PUT', fixturePart(size, n, seed, buffer));
    discard(response);
    signal.throwIfAborted();
    if (response?.status !== 204 || response.redirected || response.body !== null) throw unverified();
    accepted(n);
    signal.throwIfAborted();
  }
}

async function completeAndDownload(client, signal, path, name) {
  const completion = await send(client, signal, `${path}/complete`, 'POST', JSON.stringify({ parentId: null, name }), json);
  const { id } = await readReply(completion, 201, signal);
  if (!isUuid(id)) throw unverified();
  return send(client, signal, `/api/download/${id}`, 'GET');
}

async function exercise(context, signal, openClient, resumable) {
  try {
    const { sha, version, runId, attempt, prefix } = context;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha) || !isUuid(version) ||
        prefix !== qualificationPrefix({ runId, attempt })) throw unverified();
    const scope = Object.freeze({ sha, version, runId, attempt, prefix });
    const stop = new AbortController();
    const initial = resumable ? AbortSignal.any([signal, stop.signal]) : signal;
    initial.throwIfAborted();
    let client = await openClient(scope, initial);
    if (typeof client?.request !== 'function' || typeof client.allocate !== 'function') throw unverified();

    const size = resumable ? resumeBytes : largeBytes;
    const name = `qualification-${runId}-${attempt}-${resumable ? 'resume' : 'large'}.bin`;
    const seed = createHash('sha256').update(`${sha}/${version}/${prefix}${name}`).digest();
    const { digest, expectedParts } = await planFixture(size, seed, initial);
    initial.throwIfAborted();
    const allocation = await client.allocate({ size, expectedParts }, initial);
    const { id } = await readReply(allocation, 201, initial);
    if (!isUuid(id)) throw unverified();
    const path = `${uploads}/${id}`;

    try {
      // Abort only between acknowledged writes; a lost acknowledgement must never trigger continuation.
      await sendParts(client, initial, path, size, seed, 1, n => {
        if (resumable && n === interruptionPart) stop.abort();
      });
    } catch (error) {
      if (!resumable || !stop.signal.aborted || error !== stop.signal.reason) throw error;
    }
    if (resumable) {
      signal.throwIfAborted();
      client = await openClient(scope, signal);
      const evidence = await readReply(await send(client, signal, `${path}/resume`, 'GET'), 200, signal, 64 * 1024);
      if (evidence?.declaredSize !== size || !Array.isArray(evidence.parts) || evidence.parts.length !== interruptionPart ||
          !evidence.parts.every((part, i) => part?.partNumber === expectedParts[i].partNumber &&
            part.sizeBytes === expectedParts[i].sizeBytes && part.sha256 === expectedParts[i].sha256)) throw unverified();
      await sendParts(client, signal, path, size, seed, evidence.parts.length + 1);
    }
    const download = await completeAndDownload(client, signal, path, name);
    if (!resumable) return await verifyQualificationLargeDownload(download, digest, signal);
    await verifyQualificationDownload(download, size, digest, signal);
    return { 'interrupted-transfer-resume': 'pass' };
  } catch {
    throw unverified();
  }
}

// Unwired. The protected caller supplies the phase signal and a candidate- and
// attempt-bound client factory; fresh clients must authenticate as the same owner.
// Requests are same-origin, abortable, non-retrying, and drain upload bodies before
// settling. allocate must use admitted app routes that constrain every storage
// key to scope.prefix, even on a lost response, and enforce the sealed digests.
// Never fall back to ordinary size-only, unscoped allocation.
export const exerciseQualificationLargeTransfer = (context, signal, openClient) => exercise(context, signal, openClient, false);
export const exerciseQualificationResume = (context, signal, openClient) => exercise(context, signal, openClient, true);
