import { Sessions, tokenHash } from './identity/sessions';
import { UploadIntents, type UploadAllocationDatabase } from './metadata/upload-intents';
import { uploadCompletionBudget, uploadStorageEvidence } from './metadata/upload-storage-evidence';
import { allowsOrigin, authOrigin, readSession, type DriveAuthEnv } from './request-auth';
import type { S3Config } from './s3/config';
import { createMultipartCreate } from './s3/multipart-create';

// The first-upload preview fits in one existing bounded part.
export const maxUploadIntentBytes = 16 * 1024 * 1024;
export interface UploadIntentEnv extends DriveAuthEnv {
  DB?: UploadAllocationDatabase;
  DRIVE_UPLOAD_S3?: S3Config;
  DRIVE_UPLOAD_EPOCH?: string;
  DRIVE_UPLOAD_VERIFIER?: {
    isQualified(storageConfigId: string, signal: AbortSignal): Promise<boolean>;
    completionTimeoutMs?(storageConfigId: string): number | null;
  };
}
const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers });

const intentBodyLimit = 64;
const intentReadMs = 2_000;

async function readIntentSize(request: Request): Promise<number | null> {
  const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const length = request.headers.get('content-length');
  if (type !== 'application/json' || !request.body || request.body.locked || request.signal.aborted ||
      (length !== null && (!/^\d{1,2}$/.test(length) || +length < 1 || +length > intentBodyLimit))) return null;

  const limit = length === null ? intentBodyLimit : +length;
  const bytes = new Uint8Array(limit), reader = request.body.getReader();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(intentReadMs)]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const deadline = performance.now() + intentReadMs;
  try {
    let offset = 0, reads = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (signal.aborted || performance.now() >= deadline) { cancel(); return null; }
      if (done) break;
      if (value.length > limit - offset) { cancel(); return null; }
      bytes.set(value, offset);
      offset += value.length;
      // Ready reads, including empty chunks, must not starve the deadline timer.
      if (++reads % 64 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (length !== null && offset !== limit) return null;
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset));
    // Accept the browser's integer form without duplicate-key or floating-point normalization.
    const match = /^[\t\n\r ]*\{[\t\n\r ]*"size"[\t\n\r ]*:[\t\n\r ]*(0|[1-9][0-9]*)[\t\n\r ]*\}[\t\n\r ]*$/.exec(json);
    return match ? Number(match[1]) : null;
  } catch { return null; }
  finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export async function postUploadIntent(request: Request, env: UploadIntentEnv,
  transport?: Parameters<typeof createUploadIntent>[3]): Promise<Response> {
  const size = await readIntentSize(request);
  if (size === null) return reply(400);
  const { DB, DRIVE_ORIGIN, DRIVE_UPLOAD_S3, DRIVE_UPLOAD_EPOCH, DRIVE_UPLOAD_VERIFIER: verifier } = env;
  return createUploadIntent(request, size, {
    DB, DRIVE_ORIGIN, DRIVE_UPLOAD_S3, DRIVE_UPLOAD_EPOCH,
    // Do not allocate against storage the part and completion routes cannot use.
    DRIVE_UPLOAD_VERIFIER: verifier && { async isQualified(id, signal) {
      return await verifier.isQualified(id, signal) === true && uploadCompletionBudget(verifier, id) !== null;
    } },
  }, transport);
}

// Server-only; the caller supplies a parsed byte count and trusted Worker bindings.
export async function createUploadIntent(request: Request, size: number, env: UploadIntentEnv,
  transport = { fetch: (input: Request) => globalThis.fetch(input), timeoutMs: 5000 }): Promise<Response> {
  const origin = authOrigin(env.DRIVE_ORIGIN);
  const { DB: db, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: epoch, DRIVE_UPLOAD_VERIFIER: verifier } = env;
  if (!origin || !db) return reply(503);
  if (request.method !== 'POST') return reply(405);
  if (!allowsOrigin(request, origin.origin)) return reply(403);
  let sent = false;
  try {
    const session = await readSession(request, db);
    if (!session) return reply(401);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxUploadIntentBytes) return reply(400);
    if (!config || !epoch || !verifier) return reply(503);
    const { token, principal: { id: owner } } = session;
    const { settings, storageConfigId } = uploadStorageEvidence(config, epoch);
    const sessionDeadline = async () => {
      // Charge the entire D1 round trip against its remaining lifetime; no shared clock required.
      const started = performance.now();
      const live = await new Sessions(db).lookupWithRemainingLifetime(token);
      return live?.id === owner ? started + live.remaining_ms : 0;
    };
    const { fetch, timeoutMs } = transport;
    let deadline = 0;
    const allocate = createMultipartCreate(settings, { timeoutMs, async fetch(input) {
      if (!(input instanceof Request) || input.signal.aborted ||
        await verifier.isQualified(storageConfigId, input.signal) !== true) throw new Error('Allocation not admitted');
      const expires = await sessionDeadline();
      if (input.signal.aborted || request.signal.aborted ||
        !(performance.now() < Math.min(deadline, expires))) throw new Error('Allocation not admitted');
      sent = true;
      return fetch(input);
    } });
    if (request.signal.aborted || timeoutMs > 0x7fffffff) return reply(503);
    const preflight = new AbortController();
    const signal = AbortSignal.any([request.signal, preflight.signal]);
    const cutoff = performance.now() + timeoutMs;
    const timer = setTimeout(() => preflight.abort(), timeoutMs);
    let stop: () => void;
    const stopped = new Promise<false>(resolve => {
      stop = () => resolve(false);
      signal.addEventListener('abort', stop, { once: true });
    });
    try {
      if (await Promise.race([verifier.isQualified(storageConfigId, signal), stopped]) !== true ||
        signal.aborted || performance.now() >= cutoff) return reply(503);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop!);
    }
    const intents = new UploadIntents(db);
    const { endpoint, bucket } = settings;
    const claim = await intents.claimNewAllocation(owner, await tokenHash(token), size, endpoint, bucket, epoch);
    if (!claim) return reply(401);
    const { id, object_key: key, version } = claim;
    try {
      // The final admission checks run inside transport's response budget.
      deadline = performance.now() + timeoutMs;
      const { uploadId } = await allocate(key, request.signal);
      if (!await intents.recordSuccess(owner, id, version, { kind: 'allocation', uploadId })) return reply(409);
    } catch {
      // An interrupted journal write remains fenced by the durable claim.
      const record = sent ? intents.recordUncertain(owner, id, version, 'allocation')
        : intents.recordNotDispatched(owner, id, version, 'allocation');
      await record.catch(() => {});
      return reply(sent ? 409 : 503);
    }
    const expires = await sessionDeadline();
    return performance.now() < expires ? Response.json({ id }, { status: 201, headers }) : reply(401);
  } catch {
    // After dispatch, a failure to return the ID is not a pre-dispatch outage.
    return reply(sent ? 409 : 503);
  }
}
