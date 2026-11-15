import { createS3Transport } from './transport';

/** Object operations use one signed request and never expose transport errors. */
export function createS3Objects(...args: Parameters<typeof createS3Transport>) {
  const request = createS3Transport(...args);

  function validateKey(key: string) {
    if (!key || key.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new Error('Invalid S3 object key');
    }
    try { encodeURIComponent(key); } catch { throw new Error('Invalid S3 object key'); }
  }

  async function mutate(method: 'PUT' | 'DELETE', key: string, body?: Uint8Array, signal?: AbortSignal) {
    validateKey(key);
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
    if (response.status === 408 || response.status >= 500) throw new Error('S3 mutation outcome uncertain');
    throw new Error(`S3 request failed with status ${response.status}`);
  }

  return {
    put(key: string, body: Uint8Array, signal?: AbortSignal) { return mutate('PUT', key, body, signal); },
    delete(key: string, signal?: AbortSignal) { return mutate('DELETE', key, undefined, signal); },
    async get(key: string, options: { maxResponseBytes: number; signal?: AbortSignal; range?: string; ifMatch?: string; ifNoneMatch?: string; ifRange?: string }) {
      validateKey(key);
      let response: Awaited<ReturnType<typeof request.stream>>;
      try {
        const headers = new Headers();
        if (options.range !== undefined) headers.set('range', options.range);
        if (options.ifMatch !== undefined) headers.set('if-match', options.ifMatch);
        if (options.ifNoneMatch !== undefined) headers.set('if-none-match', options.ifNoneMatch);
        if (options.ifRange !== undefined) headers.set('if-range', options.ifRange);
        response = await request.stream({ method: 'GET', key, headers, signal: options.signal, maxResponseBytes: options.maxResponseBytes });
      } catch {
        throw new Error(options.signal?.aborted ? 'S3 request cancelled' : 'S3 request failed');
      }
      const metadata = { etag: response.headers.get('etag'), contentLength: response.headers.get('content-length'), contentRange: response.headers.get('content-range') };
      if (response.status === 200 || response.status === 206) return { status: response.status, ...metadata, body: response.body };
      void response.body.cancel().catch(() => {});
      if (response.status === 304 || response.status === 404 || response.status === 412 || response.status === 416) {
        return { status: response.status, ...metadata };
      }
      throw new Error(`S3 request failed with status ${response.status}`);
    },
    async head(key: string, options: { signal?: AbortSignal; ifMatch?: string; ifNoneMatch?: string } = {}) {
      validateKey(key);
      let response: Awaited<ReturnType<typeof request>>;
      try {
        const headers = new Headers();
        if (options.ifMatch !== undefined) headers.set('if-match', options.ifMatch);
        if (options.ifNoneMatch !== undefined) headers.set('if-none-match', options.ifNoneMatch);
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
