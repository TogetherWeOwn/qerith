import { returnedChecksums } from './checksums';
import { createS3Transport } from './transport';

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const viewLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const viewOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const viewBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;

/** Upload one bounded part with a single signed request. */
export function createMultipartUpload(...args: Parameters<typeof createS3Transport>) {
  const request = createS3Transport(...args);
  return async (key: string, uploadId: string, partNumber: number, body: Uint8Array, signal?: AbortSignal) => {
    if (!key || key.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error('Invalid S3 object key');
    if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) throw new Error('Invalid multipart upload');
    try { encodeURIComponent(key); encodeURIComponent(uploadId); } catch { throw new Error('Invalid multipart upload'); }
    const size: number = viewLength.call(body);
    if (size > 16 * 1024 * 1024) throw new Error('S3 request body exceeds part limit');
    if (signal?.aborted) throw new Error('S3 request cancelled');
    const snapshot = new Uint8Array(new Uint8Array(viewBuffer.call(body), viewOffset.call(body), size));
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request({ method: 'PUT', key, query: { partNumber: String(partNumber), uploadId }, body: snapshot, signal, maxResponseBytes: 8192 });
    } catch {
      throw new Error('S3 part upload outcome uncertain');
    }
    if (response.status === 200) {
      const etag = response.headers.get('etag');
      // The part journal accepts at most 8 KiB of opaque ETag bytes.
      if (!etag || etag.length > 8192 || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) throw new Error('S3 part upload outcome uncertain');
      const checksums = returnedChecksums(response.headers);
      return { partNumber, etag, size, ...(checksums ? { checksums } : {}) };
    }
    if (response.status === 408 || response.status >= 500 || (response.status >= 200 && response.status < 300)) throw new Error('S3 part upload outcome uncertain');
    throw new Error(`S3 request failed with status ${response.status}`);
  };
}
