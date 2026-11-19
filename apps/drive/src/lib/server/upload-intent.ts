import { Sessions, tokenHash } from './identity/sessions';
import { UploadIntents, type UploadAllocationDatabase } from './metadata/upload-intents';
import { uploadStorageEvidence } from './metadata/upload-storage-evidence';
import { allowsOrigin, authOrigin, readSession, type DriveAuthEnv } from './request-auth';
import type { S3Config } from './s3/config';
import { createMultipartCreate } from './s3/multipart-create';

// The first-upload preview fits in one existing bounded part.
export const maxUploadIntentBytes = 16 * 1024 * 1024;
interface UploadIntentEnv extends DriveAuthEnv {
  DB?: UploadAllocationDatabase;
  DRIVE_UPLOAD_S3?: S3Config;
  DRIVE_UPLOAD_EPOCH?: string;
  DRIVE_UPLOAD_VERIFIER?: { isQualified(storageConfigId: string): Promise<boolean> };
}
const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers });

// Server-only; the caller supplies a parsed byte count and trusted Worker bindings.
export async function createUploadIntent(request: Request, size: number, env: UploadIntentEnv,
  transport = { fetch: globalThis.fetch, timeoutMs: 5000 }): Promise<Response> {
  const origin = authOrigin(env.DRIVE_ORIGIN);
  const { DB: db, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: epoch, DRIVE_UPLOAD_VERIFIER: verifier } = env;
  if (!origin || !db) return reply(503);
  if (request.method !== 'POST') return reply(405);
  if (!allowsOrigin(request, origin.origin)) return reply(403);
  try {
    const session = await readSession(request, db);
    if (!session) return reply(401);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxUploadIntentBytes) return reply(400);
    if (!config || !epoch || !verifier) return reply(503);
    const { token, principal: { id: owner } } = session;
    const { settings, storageConfigId } = uploadStorageEvidence(config, epoch);
    const live = async () => (await new Sessions(db).lookup(token))?.id === owner;
    let sent = false;
    const allocate = createMultipartCreate(settings, { ...transport, async fetch(input) {
      if (await verifier.isQualified(storageConfigId) !== true || !await live() ||
        !(input instanceof Request) || input.signal.aborted || request.signal.aborted) throw new Error('Allocation not admitted');
      sent = true;
      return transport.fetch(input);
    } });
    if (await verifier.isQualified(storageConfigId) !== true || request.signal.aborted) return reply(503);
    const intents = new UploadIntents(db);
    const { endpoint, bucket } = settings;
    const claim = await intents.claimNewAllocation(owner, await tokenHash(token), size, endpoint, bucket, epoch);
    if (!claim) return reply(401);
    const { id, object_key: key, version } = claim;
    try {
      const { uploadId } = await allocate(key, request.signal);
      if (!await intents.recordSuccess(owner, id, version, { kind: 'allocation', uploadId })) return reply(409);
    } catch {
      // An interrupted journal write remains fenced by the durable claim.
      const record = sent ? intents.recordUncertain(owner, id, version, 'allocation')
        : intents.recordNotDispatched(owner, id, version, 'allocation');
      await record.catch(() => {});
      return reply(sent ? 409 : 503);
    }
    return await live() ? Response.json({ id }, { status: 201, headers }) : reply(401);
  } catch { return reply(503); }
}
