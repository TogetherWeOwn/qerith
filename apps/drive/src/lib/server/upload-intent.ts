import { multipartFileLimit } from '../multipart-upload-plan';
import { firstReleaseUploadCapBytes } from './first-release-upload-limit.mjs';
import { readBoundedBody } from './bounded-io';
import { Sessions, tokenHash } from './identity/sessions';
import { UploadIntents, type ExpectedUploadPart, type UploadAllocationDatabase } from './metadata/upload-intents';
import { uploadCompletionBudget, uploadStorageEvidence } from './metadata/upload-storage-evidence';
import { firstReleaseOrigin, qualificationAllocationPrefix, usesOwnerStorage, type QualificationReadinessEnv } from './qualification-readiness';
import { admitsStagingInvite, allowsOrigin, authOrigin, driveUploadMode, readSession, privateDriveOrigin, type DriveAuthEnv } from './request-auth';
import type { S3Config } from './s3/config';
import { MAX_PART_BYTES } from './s3/multipart-completion';
import { createMultipartCreate } from './s3/multipart-create';

// The first-upload preview fits in one existing bounded part.
export const maxUploadIntentBytes = MAX_PART_BYTES;
export interface UploadIntentEnv extends DriveAuthEnv, QualificationReadinessEnv {
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
const sha256HexLength = 64;
const multipartLimit = (env: UploadIntentEnv) => firstReleaseOrigin(env) === null ? multipartFileLimit : firstReleaseUploadCapBytes;
const intentReadMs = 2_000;
type IntentInput = { size: number; expectedParts?: readonly ExpectedUploadPart[] };

async function readIntent(request: Request, multipartLimit: number | null): Promise<IntentInput | null> {
  const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const length = request.headers.get('content-length');
  const bodyLimit = multipartLimit === null ? intentBodyLimit :
    JSON.stringify({ size: multipartLimit, expectedPartSha256s: '' }).length +
    Math.ceil(multipartLimit / MAX_PART_BYTES) * sha256HexLength;
  const lengthPattern = multipartLimit === null ? /^\d{1,2}$/ : /^\d{1,5}$/;
  if (type !== 'application/json' || !request.body || request.body.locked || request.signal.aborted ||
      (length !== null && (!lengthPattern.test(length) || +length < 1 || +length > bodyLimit))) return null;

  const limit = length === null ? bodyLimit : +length;
  try {
    const bytes = await readBoundedBody(request.body, {
      maxBytes: limit, exact: length !== null, timeoutMs: intentReadMs, signal: request.signal,
    });
    if (!bytes || request.signal.aborted) return null;
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    // Preserve the legacy request's original byte and Content-Length limits.
    if (bytes.length <= intentBodyLimit && (length === null || length.length <= 2)) {
      const legacy = /^[\t\n\r ]*\{[\t\n\r ]*"size"[\t\n\r ]*:[\t\n\r ]*(0|[1-9][0-9]*)[\t\n\r ]*\}[\t\n\r ]*$/.exec(json);
      if (legacy) return { size: Number(legacy[1]) };
    }
    if (multipartLimit === null) return null;
    // Match only the compact browser serialization; no escapes, duplicate keys or numeric normalization.
    const bound = /^\{"size":(0|[1-9][0-9]{0,9}),"expectedPartSha256s":"([0-9a-f]+)"\}$/.exec(json);
    if (!bound || bound[0] !== json) return null;
    const size = Number(bound[1]), packed = bound[2];
    const count = Math.max(1, Math.ceil(size / MAX_PART_BYTES));
    if (size > multipartLimit || packed.length !== count * sha256HexLength) return null;
    const expectedParts = Array.from({ length: count }, (_, i) => ({
      partNumber: i + 1,
      sizeBytes: Math.min(MAX_PART_BYTES, size - i * MAX_PART_BYTES),
      sha256: packed.slice(i * sha256HexLength, (i + 1) * sha256HexLength),
    }));
    return { size, expectedParts };
  } catch { return null; }
}

export async function postUploadIntent(request: Request, env: UploadIntentEnv,
  transport?: Parameters<typeof createUploadIntent>[3]): Promise<Response> {
  const input = await readIntent(request, admitsStagingInvite(env) || usesOwnerStorage(env) ? multipartLimit(env) : null);
  if (!input || request.signal.aborted) return reply(400);
  const { DRIVE_UPLOAD_VERIFIER: verifier } = env;
  return createUploadIntent(request, input.size, {
    ...env,
    // Do not allocate against storage the part and completion routes cannot use.
    DRIVE_UPLOAD_VERIFIER: verifier && { async isQualified(id, signal) {
      return await verifier.isQualified(id, signal) === true && uploadCompletionBudget(verifier, id) !== null;
    } },
  }, transport, input.expectedParts);
}

// Server-only; the caller supplies a parsed declaration and trusted Worker bindings.
export async function createUploadIntent(request: Request, size: number, env: UploadIntentEnv,
  transport = { fetch: (input: Request) => globalThis.fetch(input), timeoutMs: 5000 },
  expectedParts?: readonly ExpectedUploadPart[]): Promise<Response> {
  const origin = authOrigin(env.DRIVE_ORIGIN);
  const { DB: db, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: epoch, DRIVE_UPLOAD_VERIFIER: verifier } = env;
  if (!origin || !db) return reply(503);
  if (request.method !== 'POST') return reply(405);
  if (!allowsOrigin(request, origin.origin)) return reply(403);
  const prefix = qualificationAllocationPrefix(env);
  if (prefix === null) return reply(503);
  if (prefix && request.url !== origin.origin + '/api/uploads') return reply(404);
  // Allocation only; staging request admission and part/publication policy are separate.
  const inviteMode = admitsStagingInvite(env);
  const ownerOnly = privateDriveOrigin(env) !== null && !inviteMode;
  let sent = false;
  try {
    const session = await readSession(request, db);
    if (!session || (ownerOnly && session.principal.role !== 'owner')) return reply(401);
    const mode = driveUploadMode(env, session.principal.role);
    const admittedMultipart = firstReleaseOrigin(env) === null ? inviteMode : mode === 'multipart';
    const limit = admittedMultipart ? multipartLimit(env) : maxUploadIntentBytes;
    if (!Number.isSafeInteger(size) || size < 0 || size > limit ||
        (expectedParts && mode !== 'multipart')) return reply(400);
    if (!config || !epoch || !verifier) return reply(503);
    const { token, principal: { id: owner } } = session;
    const { settings, storageConfigId } = uploadStorageEvidence(config, epoch);
    const sessionDeadline = async () => {
      // Charge the entire D1 round trip against its remaining lifetime; no shared clock required.
      const started = performance.now();
      const live = await new Sessions(db).lookupWithRemainingLifetime(token);
      return live?.id === owner && (!ownerOnly || live.role === 'owner') ? started + live.remaining_ms : 0;
    };
    const { fetch, timeoutMs } = transport;
    let deadline = 0;
    const allocate = createMultipartCreate(settings, { timeoutMs, async fetch(input) {
      if (!(input instanceof Request) || input.signal.aborted ||
        await verifier.isQualified(storageConfigId, input.signal) !== true) throw new Error('Allocation not admitted');
      const expires = await sessionDeadline();
      if (input.signal.aborted || request.signal.aborted ||
        (prefix && qualificationAllocationPrefix(env) !== prefix) ||
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
    const sessionHash = await tokenHash(token);
    if (prefix && (request.signal.aborted || qualificationAllocationPrefix(env) !== prefix)) return reply(503);
    const claim = expectedParts
      ? await intents.claimNewExpectedAllocation(owner, sessionHash, size, endpoint, bucket, epoch, 'active', expectedParts, prefix)
      : await intents.claimNewAllocation(owner, sessionHash, size, endpoint, bucket, epoch, ownerOnly, prefix);
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
