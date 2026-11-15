import { createS3Transport } from './transport';

/** Abort an upload with one signed request; ambiguous outcomes require reconciliation. */
export function createMultipartAbort(...args: Parameters<typeof createS3Transport>) {
  const request = createS3Transport(...args);
  return async (key: string, uploadId: string, signal?: AbortSignal) => {
    if (!key || key.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error('Invalid S3 object key');
    if (!uploadId) throw new Error('Invalid multipart upload');
    try { encodeURIComponent(key); encodeURIComponent(uploadId); } catch { throw new Error('Invalid multipart upload'); }
    if (signal?.aborted) throw new Error('S3 request cancelled');
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request({ method: 'DELETE', key, query: { uploadId }, signal, maxResponseBytes: 8192 });
    } catch {
      throw new Error('S3 multipart abort outcome uncertain');
    }
    if (response.status === 204) return;
    if (response.status === 408 || response.status >= 500 || (response.status >= 200 && response.status < 300)) throw new Error('S3 multipart abort outcome uncertain');
    throw new Error(`S3 request failed with status ${response.status}`);
  };
}
