import { readBoundedBody } from './bounded-io';
import { createCompleteForPublication } from './s3/complete-for-publication';
import type { S3Config } from './s3/config';
import { createS3Listing } from './s3/listing';
import { createMultipartAbort } from './s3/multipart-abort';
import { createMultipartCreate } from './s3/multipart-create';
import { createMultipartUpload } from './s3/multipart-upload';
import { createS3Objects } from './s3/objects';
import { createS3Transport } from './s3/transport';

/** Exercise Drive's file I/O on unique keys reserved for connection tests. */
export async function verifyStorageSettings(config: S3Config, fetch: typeof globalThis.fetch, caller: AbortSignal,
  liveOwner: () => Promise<boolean>): Promise<void> {
  const key = `drive-storage-probes/${crypto.randomUUID()}`;
  const data = crypto.getRandomValues(new Uint8Array(32));
  const signal = AbortSignal.any([caller, AbortSignal.timeout(15_000)]);
  const options = { fetch, timeoutMs: 3000, beforeSend: async () => !signal.aborted && await liveOwner() && !signal.aborted };
  const create = createMultipartCreate(config, options);
  const abort = createMultipartAbort(config, options);
  const send = createS3Transport(config, options);
  const cleanup = createS3Transport(config, { fetch, timeoutMs: 2500 });
  let uploadId: string | undefined;
  let completionSent = false;
  try {
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
    if (result.size !== data.byteLength) throw new Error('Storage length proof failed');
    const received = await createS3Objects(config, options).get(key, {
      range: 'bytes=0-15', ifMatch: result.etag, maxResponseBytes: 16, signal,
    });
    if (received.status !== 206 || received.etag !== result.etag || received.contentRange !== 'bytes 0-15/32') {
      if ('body' in received) void received.body?.cancel().catch(() => {});
      throw new Error('Storage range proof failed');
    }
    const bytes = await readBoundedBody(received.body!, { maxBytes: 16, exact: true, timeoutMs: 3000, signal });
    if (!bytes?.every((byte, i) => byte === data[i])) throw new Error('Storage byte proof failed');
    const deleted = await removeProbe(send, key, signal, result.etag);
    if (!deleted) throw new Error('Storage cleanup proof failed');
    completionSent = false;
    signal.throwIfAborted();
  } finally {
    // Cleanup uses a separate short budget after a failed or interrupted test. No user keys are touched.
    const cleanupSignal = AbortSignal.timeout(5000);
    if (uploadId) await createMultipartAbort(config, { fetch, timeoutMs: 2500 })(key, uploadId, cleanupSignal).catch(() => {});
    if (completionSent) await removeProbe(cleanup, key, cleanupSignal).catch(() => {});
  }
}

async function removeProbe(send: ReturnType<typeof createS3Transport>, key: string, signal: AbortSignal,
  expectedEtag?: string): Promise<boolean> {
  const head = await send({ method: 'HEAD', key, signal, maxResponseBytes: 0 });
  if (!expectedEtag && head.status === 404) return true;
  const etag = head.headers.get('etag');
  if (head.status !== 200 || !etag || (expectedEtag && etag !== expectedEtag)) return false;
  const version = head.headers.get('x-amz-version-id');
  const removed = await send({ method: 'DELETE', key, signal, headers: { 'if-match': etag },
    query: version ? { versionId: version } : undefined, maxResponseBytes: 8192 });
  if (removed.status !== 204) return false;
  return (await send({ method: 'HEAD', key, signal, maxResponseBytes: 0 })).status === 404;
}
