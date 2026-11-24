import { readBoundedBody, withIoDeadline } from './bounded-io';
import { newUploadObjectKey } from './metadata/upload-intents';
import { decodeUploadIdentity } from './metadata/upload-storage-evidence';
import { createCompleteForPublication } from './s3/complete-for-publication';
import type { S3Config } from './s3/config';
import { createS3Listing, S3MultipartUploadMissing } from './s3/listing';
import { createMultipartAbort } from './s3/multipart-abort';
import { createMultipartCreate } from './s3/multipart-create';
import { createMultipartUpload } from './s3/multipart-upload';
import { createS3Objects } from './s3/objects';
import { createS3Transport } from './s3/transport';

export interface StorageContinuity {
  file: { keyHex: string; etag: string; size: number } | null;
  upload: { keyHex: string; uploadHex: string } | null;
}

/** Use a fresh key with the same layout as ordinary uploads, without publishing Drive metadata. */
export async function verifyStorageSettings(config: S3Config, fetch: typeof globalThis.fetch, caller: AbortSignal,
  liveOwner: () => Promise<boolean>, continuity?: StorageContinuity): Promise<void> {
  const key = newUploadObjectKey();
  const data = crypto.getRandomValues(new Uint8Array(32));
  let uploadId: string | undefined;
  let completionSent = false;
  let probeEtag: string | undefined;
  try {
    await withIoDeadline(15_000, caller, async ({ signal, check }) => {
      check();
      const options = { fetch, timeoutMs: 3000, beforeSend: async () => !signal.aborted && await liveOwner() && !signal.aborted };
      const objects = createS3Objects(config, options);
      if (continuity?.file) {
        const { keyHex, etag, size } = continuity.file;
        const head = await objects.head(decodeUploadIdentity(keyHex), { ifMatch: etag, signal });
        if (head.status !== 200 || head.etag !== etag || head.contentLength !== String(size)) throw new Error('Storage file proof failed');
      }
      if ((await objects.head(key, { signal })).status !== 404) throw new Error('Storage probe key unavailable');
      if (continuity?.upload) {
        const { keyHex, uploadHex } = continuity.upload;
        try {
          await createS3Listing(config, options).parts(decodeUploadIdentity(keyHex), decodeUploadIdentity(uploadHex), { maxParts: 1, signal });
        } catch (error) {
          // A provider-expired upload can remain allocated in D1. The fresh probe still tests ListParts.
          if (!(error instanceof S3MultipartUploadMissing)) throw error;
        }
      }
      const create = createMultipartCreate(config, options);
      const abort = createMultipartAbort(config, options);
      ({ uploadId } = await create(key, signal));
      await abort(key, uploadId, signal);
      uploadId = undefined;
      ({ uploadId } = await create(key, signal));
      const receipt = await createMultipartUpload(config, options)(key, uploadId, 1, data, signal);
      const page = await createS3Listing(config, options).parts(key, uploadId, { signal });
      const [part] = page.parts;
      if (page.parts.length !== 1 || page.nextPartNumberMarker !== undefined || part.partNumber !== 1 ||
          part.etag !== receipt.etag || part.size !== data.byteLength) throw new Error('Storage part proof failed');
      completionSent = true;
      const result = await createCompleteForPublication(config, options)(key, uploadId, page.parts, signal);
      uploadId = undefined;
      probeEtag = result.etag;
      if (result.size !== data.byteLength) throw new Error('Storage length proof failed');
      const received = await objects.get(key, {
        range: 'bytes=0-15', ifMatch: result.etag, maxResponseBytes: 16, signal,
      });
      if (received.status !== 206 || received.etag !== result.etag || received.contentRange !== 'bytes 0-15/32') {
        if ('body' in received) void received.body?.cancel().catch(() => {});
        throw new Error('Storage range proof failed');
      }
      const bytes = await readBoundedBody(received.body!, { maxBytes: 16, exact: true, timeoutMs: 3000, signal });
      if (!bytes?.every((byte, i) => byte === data[i])) throw new Error('Storage byte proof failed');
      const deleted = await removeProbe(createS3Transport(config, options), key, signal, result.etag);
      if (!deleted) throw new Error('Storage cleanup proof failed');
      completionSent = false;
    });
  } finally {
    // Cleanup uses a separate short budget after a failed or interrupted test. No user keys are touched.
    if (uploadId || completionSent) await withIoDeadline(5000, undefined, async ({ signal }) => {
      const options = { fetch, timeoutMs: 2500 };
      if (uploadId) await createMultipartAbort(config, options)(key, uploadId, signal).catch(() => {});
      if (completionSent) {
        // An uncertain completion can only be cleaned up after reading the exact synthetic bytes.
        if (!probeEtag) {
          const current = await createS3Objects(config, options).get(key, { maxResponseBytes: data.length, signal });
          if (current.status === 200 && current.body) {
            const bytes = await readBoundedBody(current.body, { maxBytes: data.length, exact: true, timeoutMs: 2500, signal });
            if (bytes?.every((byte, i) => byte === data[i])) probeEtag = current.etag ?? undefined;
          } else if ('body' in current) void current.body?.cancel().catch(() => {});
        }
        if (probeEtag) await removeProbe(createS3Transport(config, options), key, signal, probeEtag);
      }
    }).catch(() => {});
  }
}

async function removeProbe(send: ReturnType<typeof createS3Transport>, key: string, signal: AbortSignal,
  expectedEtag: string): Promise<boolean> {
  const head = await send({ method: 'HEAD', key, signal, maxResponseBytes: 0 });
  if (head.status !== 200 || head.headers.get('etag') !== expectedEtag) return false;
  const version = head.headers.get('x-amz-version-id');
  // The generated key is private to this probe. Use an exact version when the service returns one.
  const removed = await send({ method: 'DELETE', key, signal,
    query: version ? { versionId: version } : undefined, maxResponseBytes: 8192 });
  if (removed.status !== 204) return false;
  return (await send({ method: 'HEAD', key, signal, maxResponseBytes: 0 })).status === 404;
}
