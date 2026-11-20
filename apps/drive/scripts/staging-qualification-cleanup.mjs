import { execFileSync } from 'node:child_process';
import { assertQualificationJob, qualificationPrefix } from './staging-qualification.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';
import { stagingStorage } from './staging-publish.mjs';

const maxTargets = 100;
const unverified = () => new Error('Qualification R2 prefix cleanup is unverified.');

// The caller must hold the staging lock, stop all writers to this prefix, and
// use a reviewed, non-versioned R2 binding. This does not attest D1 cleanup.
export async function cleanQualificationR2(context, signal, { listing, request }) {
  const prefix = qualificationPrefix(context);
  if (context.prefix !== prefix) throw unverified();
  const inScope = key => typeof key === 'string' && key.startsWith(prefix) && key.length > prefix.length &&
    key.isWellFormed() && Buffer.byteLength(key) <= 1024 && !key.split('/').some(part => part === '.' || part === '..');

  try {
    return await runQualificationPhase(async (_, active) => {
      const inspect = async () => {
        active.throwIfAborted();
        const pending = await listing.uploads({ prefix, verifyScope: true, signal: active });
        active.throwIfAborted();
        const objects = await listing.objects({ prefix, verifyScope: true, signal: active });
        active.throwIfAborted();
        const { uploads, nextKeyMarker, nextUploadIdMarker } = pending;
        const { keys, nextContinuationToken } = objects;
        if (nextKeyMarker !== undefined || nextUploadIdMarker !== undefined || nextContinuationToken !== undefined ||
            !Array.isArray(uploads) || !Array.isArray(keys) || uploads.length + keys.length > maxTargets ||
            !keys.every(inScope) || !uploads.every(item => inScope(item?.key) &&
              typeof item.uploadId === 'string' && item.uploadId.length > 0 && item.uploadId.isWellFormed()) ||
            new Set(keys).size !== keys.length ||
            new Set(uploads.map(({ key, uploadId }) => JSON.stringify([key, uploadId]))).size !== uploads.length) {
          throw unverified();
        }
        return { uploads, keys };
      };
      const remove = async (key, uploadId) => {
        active.throwIfAborted();
        const { status } = await request({ method: 'DELETE', key, query: uploadId === undefined ? undefined : { uploadId },
          maxResponseBytes: 8192, signal: active });
        if (status !== 204 && !(uploadId !== undefined && status === 404)) throw unverified();
      };

      // Validate the complete bounded snapshot before making any DELETE request.
      const before = await inspect();
      for (const { key, uploadId } of before.uploads) await remove(key, uploadId);
      for (const key of before.keys) await remove(key);
      const after = await inspect();
      if (after.keys.length || after.uploads.length) throw unverified();
      return true;
    }, null, signal, 55_000);
  } catch {
    // Provider diagnostics may contain object identities or signing details.
    throw unverified();
  }
}

// No executable entry point. The protected lifecycle will supply this callback
// only after checking native expiry and establishing exclusive fixture scope.
export async function createQualificationR2Cleanup(env, cwd, { send = fetch } = {}) {
  const identity = assertQualificationJob(env, cwd);
  const receipt = JSON.parse(execFileSync('git', ['show', `${identity.sha}:apps/drive/scripts/staging-storage-qualification.json`],
    { cwd, encoding: 'utf8', maxBuffer: 16_384, stdio: ['ignore', 'pipe', 'pipe'] }));
  const { vars, secrets } = await stagingStorage(env, receipt);
  // Current-object listing cannot certify cleanup of hidden object versions on
  // an arbitrary S3 provider. Admit only a native, unversioned R2 endpoint.
  if (!/^https:\/\/[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/.test(vars.DRIVE_S3_ENDPOINT)) throw unverified();
  const settings = { endpoint: vars.DRIVE_S3_ENDPOINT, bucket: vars.DRIVE_S3_BUCKET, region: vars.DRIVE_S3_REGION,
    accessKeyId: secrets.DRIVE_S3_ACCESS_KEY_ID, secretAccessKey: secrets.DRIVE_S3_SECRET_ACCESS_KEY };
  const { createS3Listing } = await import('../src/lib/server/s3/listing.ts');
  const { createS3Transport } = await import('../src/lib/server/s3/transport.ts');
  const options = { fetch: send, timeoutMs: 8000 };
  const io = { listing: createS3Listing(settings, options), request: createS3Transport(settings, options) };
  return (context, signal) => {
    if (context.sha !== identity.sha || context.prefix !== qualificationPrefix(identity)) throw unverified();
    return cleanQualificationR2(context, signal, io);
  };
}
