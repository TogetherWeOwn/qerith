import { withIoDeadline } from './bounded-io';
import { uploadStorageEvidence } from './metadata/upload-storage-evidence';
import type { QualificationReadinessEnv } from './qualification-readiness';
import type { DriveAuthEnv } from './request-auth';
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
  return {
    async isQualified(id: string, signal?: AbortSignal) { return id === storageConfigId && !signal?.aborted; },
    completionTimeoutMs(id) { return id === storageConfigId ? budget : null; },
    async verifyParts({ storageConfigId: id, objectKey, uploadId, beforeSend }) {
      if (id !== storageConfigId) return null;
      return withIoDeadline(listTimeoutMs, undefined, async ({ signal, check }) => {
        const listing = createS3Listing(settings, { fetch: transport, timeoutMs: listTimeoutMs,
          beforeSend: async () => {
            check();
            const admitted = !beforeSend || await beforeSend() === true;
            check();
            return admitted;
          } });
        const parts: CompletedPart[] = [];
        let retainedEtagBytes = 0;
        let marker: number | undefined;
        do {
          check();
          const page = await listing.parts(objectKey, uploadId, { partNumberMarker: marker, signal });
          check();
          if (parts.length + page.parts.length > MAX_PARTS) return null;
          for (const part of page.parts) {
            const { etag } = part;
            if (etag.length > maxPartEtagBytes || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) return null;
            retainedEtagBytes += 2 * etag.length;
            if (retainedEtagBytes > maxRetainedEtagBytes) return null;
            // Rebuild from the validated Latin-1 bytes so a parser substring cannot retain the XML page.
            const detachedEtag = String.fromCharCode(...Uint8Array.from(etag, (char) => char.charCodeAt(0)));
            parts.push({ ...part, etag: detachedEtag });
          }
          marker = page.nextPartNumberMarker;
        } while (marker !== undefined);
        return parts.length ? parts : null;
      }).catch(() => null);
    }
  };
}

export function wireUploadStorage<DB>(env: StorageBindings & { DB?: DB } & QualificationReadinessEnv &
  Pick<DriveAuthEnv, 'DRIVE_STAGING_INVITE_ACCEPTANCE'>,
  transport: typeof fetch = (input, init) => fetch(input, init)) {
  const identity = storageIdentity(env);
  return {
    DB: env.DB,
    DRIVE_ORIGIN: env.DRIVE_ORIGIN,
    DRIVE_FIRST_RELEASE_ORIGIN: env.DRIVE_FIRST_RELEASE_ORIGIN,
    DRIVE_SIGN_IN_FIXTURE: env.DRIVE_SIGN_IN_FIXTURE,
    DRIVE_QUALIFICATION_SHA: env.DRIVE_QUALIFICATION_SHA,
    DRIVE_QUALIFICATION_VERSION: env.DRIVE_QUALIFICATION_VERSION,
    DRIVE_QUALIFICATION_EXPIRES_AT: env.DRIVE_QUALIFICATION_EXPIRES_AT,
    DRIVE_QUALIFICATION_RUN_ID: env.DRIVE_QUALIFICATION_RUN_ID,
    DRIVE_QUALIFICATION_RUN_ATTEMPT: env.DRIVE_QUALIFICATION_RUN_ATTEMPT,
    DRIVE_STAGING_INVITE_ACCEPTANCE: env.DRIVE_STAGING_INVITE_ACCEPTANCE,
    DRIVE_UPLOAD_S3: identity?.settings,
    DRIVE_UPLOAD_EPOCH: identity?.epoch,
    DRIVE_UPLOAD_VERIFIER: identity ? storageVerifier(identity, env.DRIVE_S3_QUALIFICATION, transport) : undefined
  };
}
