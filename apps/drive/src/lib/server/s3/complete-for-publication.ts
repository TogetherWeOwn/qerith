import { createMultipartComplete } from './multipart-complete';
import type { CompletedPart } from './multipart-completion';
import { createS3Objects } from './objects';
import { createS3Transport } from './transport';

// Use only in the same request that publishes the result; neither failure is retried.
export function createCompleteForPublication(...args: Parameters<typeof createS3Transport>) {
  const config = { ...args[0] };
  const complete = createMultipartComplete(config, args[1]);
  const objects = createS3Objects(config, args[1]);
  return async (key: string, uploadId: string, parts: readonly CompletedPart[], signal?: AbortSignal) => {
    const result = await complete(key, uploadId, parts, signal);
    const head = await objects.head(key, { ifMatch: result.etag, signal });
    if (head.status !== 200 || head.etag !== result.etag ||
        typeof head.contentLength !== 'string' || !/^\d+$/.test(head.contentLength)) {
      throw new Error('S3 completion HEAD evidence mismatch');
    }
    const size = Number(head.contentLength);
    if (!Number.isSafeInteger(size)) throw new Error('S3 completion HEAD evidence mismatch');
    return { etag: result.etag, size };
  };
}
