import { uploadStorageEvidence } from './metadata/upload-storage-evidence';
import { createS3Listing } from './s3/listing';
import { MAX_PARTS, type CompletedPart } from './s3/multipart-completion';
import type { UploadRouteEnv } from './upload-routes';

export interface StorageBindings {
  DRIVE_S3_ENDPOINT?: string;
  DRIVE_S3_BUCKET?: string;
  DRIVE_S3_REGION?: string;
  DRIVE_S3_ACCESS_KEY_ID?: string;
  DRIVE_S3_SECRET_ACCESS_KEY?: string;
  DRIVE_S3_STORAGE_EPOCH?: string;
  DRIVE_S3_QUALIFICATION?: string;
}

export function storageIdentity(env: StorageBindings) {
  const { DRIVE_S3_ENDPOINT: endpoint, DRIVE_S3_BUCKET: bucket, DRIVE_S3_REGION: region,
    DRIVE_S3_ACCESS_KEY_ID: accessKeyId, DRIVE_S3_SECRET_ACCESS_KEY: secretAccessKey,
    DRIVE_S3_STORAGE_EPOCH: epoch } = env;
  if (typeof endpoint !== 'string' || typeof bucket !== 'string' || typeof region !== 'string' ||
      typeof accessKeyId !== 'string' || typeof secretAccessKey !== 'string' || typeof epoch !== 'string') return null;
  try {
    return { ...uploadStorageEvidence({ endpoint, bucket, region, accessKeyId, secretAccessKey }, epoch), epoch };
  } catch { return null; }
}

function qualifiedBudget(proof: string | undefined, storageConfigId: string, region: string): number | null {
  // This binding qualifies a storage identity, not the running build. The protected
  // deployment pipeline owns the exact-SHA preview qualification separately.
  if (typeof proof !== 'string' || proof.length > 4096) return null;
  try {
    const evidence = JSON.parse(proof);
    return evidence.version === 1 && evidence.storageConfigId === storageConfigId && evidence.region === region &&
      typeof evidence.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(evidence.sourceSha) &&
      typeof evidence.runId === 'string' && /^[1-9][0-9]{0,19}$/.test(evidence.runId) &&
      Number.isSafeInteger(evidence.runAttempt) && evidence.runAttempt > 0 &&
      Number.isSafeInteger(evidence.completionTimeoutMs) && evidence.completionTimeoutMs > 0 &&
      evidence.completionTimeoutMs <= 60_000 ? evidence.completionTimeoutMs : null;
  } catch { return null; }
}

const listTimeoutMs = 5000;
const maxPartEtagBytes = 8192;
// Count retained UTF-16 ETag bytes. Even with XML escaping and MAX_PARTS entries,
// this budget fits within the downstream 16 MiB completion manifest limit.
const maxRetainedEtagBytes = 2 * 1024 * 1024;

function storageVerifier(identity: NonNullable<ReturnType<typeof storageIdentity>>, proof: string | undefined,
  transport: typeof fetch): UploadRouteEnv['DRIVE_UPLOAD_VERIFIER'] {
  const { settings, storageConfigId } = identity;
  const budget = qualifiedBudget(proof, storageConfigId, settings.region);
  if (budget === null) return undefined;
  const listing = createS3Listing(settings, { fetch: transport, timeoutMs: listTimeoutMs });
  return {
    async isQualified(id: string, signal?: AbortSignal) { return id === storageConfigId && !signal?.aborted; },
    completionTimeoutMs(id) { return id === storageConfigId ? budget : null; },
    async verifyParts({ storageConfigId: id, objectKey, uploadId }) {
      if (id !== storageConfigId) return null;
      const signal = AbortSignal.timeout(listTimeoutMs);
      const deadline = performance.now() + listTimeoutMs;
      const parts: CompletedPart[] = [];
      let retainedEtagBytes = 0;
      let marker: number | undefined;
      try {
        do {
          const page = await listing.parts(objectKey, uploadId, { partNumberMarker: marker, signal });
          if (signal.aborted || performance.now() >= deadline || parts.length + page.parts.length > MAX_PARTS) return null;
          for (const part of page.parts) {
            const { etag } = part;
            if (etag.length > maxPartEtagBytes || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) return null;
            retainedEtagBytes += 2 * etag.length;
            if (retainedEtagBytes > maxRetainedEtagBytes) return null;
            parts.push(part);
          }
          marker = page.nextPartNumberMarker;
        } while (marker !== undefined);
        return parts.length && !signal.aborted && performance.now() < deadline ? parts : null;
      } catch { return null; }
    }
  };
}

export function wireUploadStorage<DB>(env: StorageBindings & { DB?: DB; DRIVE_ORIGIN?: string },
  transport: typeof fetch = (input, init) => fetch(input, init)) {
  const identity = storageIdentity(env);
  return {
    DB: env.DB,
    DRIVE_ORIGIN: env.DRIVE_ORIGIN,
    DRIVE_UPLOAD_S3: identity?.settings,
    DRIVE_UPLOAD_EPOCH: identity?.epoch,
    DRIVE_UPLOAD_VERIFIER: identity ? storageVerifier(identity, env.DRIVE_S3_QUALIFICATION, transport) : undefined
  };
}
