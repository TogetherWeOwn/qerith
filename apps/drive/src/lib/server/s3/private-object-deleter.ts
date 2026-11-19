import type { ResolveObjectDeleter } from '../metadata/private-object-deletion';
import { uploadStorageEvidence } from '../metadata/upload-storage-evidence';
import type { S3Config } from './config';
import { createS3Transport } from './transport';

type DeleteResponse = Readonly<{ status: number; headers: Headers; body: Uint8Array }>;
type DeleteOptions = Parameters<typeof createS3Transport>[1] & {
  // Trusted, configuration-specific rule established by live qualification. It
  // must distinguish permanent removal from absence; without it nothing resolves.
  confirmsRemoval?: (response: DeleteResponse) => boolean;
};

/** Unwired resolver for one immutable storage identity. No default or current-config lookup. */
export function createS3ObjectDeleter(config: S3Config, epoch: string, options: DeleteOptions): ResolveObjectDeleter {
  const { settings, storageConfigId } = uploadStorageEvidence(config, epoch);
  const { fetch, timeoutMs, now, confirmsRemoval } = options;
  if (timeoutMs > 0x7fffffff) throw new Error('Invalid S3 timeout');
  const request = createS3Transport(settings, { fetch, timeoutMs, now });
  if (typeof confirmsRemoval !== 'function') return () => null;
  const deleter: NonNullable<ReturnType<ResolveObjectDeleter>> = Object.freeze({
    storageConfigId,
    async deleteIfMatch(target, signal): Promise<'deleted' | 'unconfirmed'> {
      try {
        const { key, etag } = target;
        if (signal.aborted || typeof key !== 'string' || !key || key.includes('\0') ||
            typeof etag !== 'string' || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) {
          return 'unconfirmed';
        }
        const response = await request({ method: 'DELETE', key, headers: { 'if-match': etag }, signal, maxResponseBytes: 8192 });
        // An accepted-but-pending operation or a version/delete marker cannot prove permanent removal.
        return !signal.aborted && (response.status === 200 || response.status === 204) &&
          !response.headers.has('x-amz-delete-marker') && !response.headers.has('x-amz-version-id') &&
          confirmsRemoval(response) === true && !signal.aborted ? 'deleted' : 'unconfirmed';
      } catch {
        return 'unconfirmed';
      }
    }
  });
  return (id) => id === storageConfigId ? deleter : null;
}
