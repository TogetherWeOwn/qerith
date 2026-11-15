import { createS3Transport } from './transport';

/** Object operations use one signed request and never expose transport errors. */
export function createS3Objects(...args: Parameters<typeof createS3Transport>) {
  const request = createS3Transport(...args);

  async function mutate(method: 'PUT' | 'DELETE', key: string, body?: Uint8Array, signal?: AbortSignal) {
    if (body && body.byteLength > 16 * 1024 * 1024) throw new Error('S3 request body exceeds part limit');
    if (signal?.aborted) throw new Error('S3 request cancelled');
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request({ method, key, body, signal, maxResponseBytes: 8192 });
    } catch {
      throw new Error('S3 mutation outcome uncertain');
    }
    if (response.status >= 200 && response.status < 300) {
      return { etag: response.headers.get('etag') };
    }
    if (response.status >= 500) throw new Error('S3 mutation outcome uncertain');
    throw new Error(`S3 request failed with status ${response.status}`);
  }

  return {
    put(key: string, body: Uint8Array, signal?: AbortSignal) { return mutate('PUT', key, body, signal); },
    delete(key: string, signal?: AbortSignal) { return mutate('DELETE', key, undefined, signal); },
    async head(key: string, options: { signal?: AbortSignal; ifMatch?: string; ifNoneMatch?: string } = {}) {
      const headers = new Headers();
      if (options.ifMatch !== undefined) headers.set('if-match', options.ifMatch);
      if (options.ifNoneMatch !== undefined) headers.set('if-none-match', options.ifNoneMatch);
      let response: Awaited<ReturnType<typeof request>>;
      try {
        response = await request({ method: 'HEAD', key, headers, signal: options.signal, maxResponseBytes: 0 });
      } catch {
        throw new Error(options.signal?.aborted ? 'S3 request cancelled' : 'S3 request failed');
      }
      if (response.status === 200) {
        return { status: 200 as const, etag: response.headers.get('etag'), contentLength: response.headers.get('content-length') };
      }
      if (response.status === 304 || response.status === 404 || response.status === 412) {
        return { status: response.status, etag: response.headers.get('etag') };
      }
      throw new Error(`S3 request failed with status ${response.status}`);
    },
  };
}
