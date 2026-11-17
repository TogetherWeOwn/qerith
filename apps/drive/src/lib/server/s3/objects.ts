import { returnedChecksums } from './checksums';
import { validateRange } from './range';
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
      response = await request({ method, key, body, signal, headers: method === 'PUT' ? { 'if-none-match': '*' } : undefined, maxResponseBytes: 8192 });
    } catch {
      throw new Error('S3 mutation outcome uncertain');
    }
    if (response.status >= 200 && response.status < 300) {
      const etag = response.headers.get('etag');
      if (method === 'PUT' && (!etag || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag))) throw new Error('S3 mutation outcome uncertain');
      const checksums = method === 'PUT' ? returnedChecksums(response.headers) : undefined;
      return { etag, ...(checksums ? { checksums } : {}) };
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
        if (options.range !== undefined) headers.set('range', validateRange(options.range));
        if (options.ifMatch !== undefined) headers.set('if-match', options.ifMatch);
        if (options.ifNoneMatch !== undefined) headers.set('if-none-match', options.ifNoneMatch);
        if (options.ifRange !== undefined) headers.set('if-range', options.ifRange);
        response = await request.stream({ method: 'GET', key, headers, signal: options.signal, maxResponseBytes: options.maxResponseBytes });
      } catch {
        throw new Error(options.signal?.aborted ? 'S3 request cancelled' : 'S3 request failed');
      }
      const metadata = { etag: response.headers.get('etag'), contentLength: response.headers.get('content-length'), contentRange: response.headers.get('content-range') };
      if (response.status === 200 || response.status === 206) {
        if (response.headers.has('content-encoding')) {
          void response.body.cancel().catch(() => {});
          throw new Error(options.signal?.aborted ? 'S3 request cancelled' : 'S3 request failed');
        }
        return { status: response.status as 200 | 206, ...metadata, body: response.body };
      }
      void response.body.cancel().catch(() => {});
      if (response.status === 304 || response.status === 404 || response.status === 412 || response.status === 416) {
        return { status: response.status as 304 | 404 | 412 | 416, ...metadata };
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

export type ImmutableS3Reference = { key: string; etag: string };

function rangeLength(requested: string, contentRange: string | null): bigint | undefined {
  const request = /^bytes=(\d*)-(\d*)$/i.exec(requested);
  const response = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(contentRange ?? '');
  if (!request || !response) return undefined;
  const [, first, last] = request;
  const start = BigInt(response[1]);
  const end = BigInt(response[2]);
  const size = BigInt(response[3]);
  if (size === 0n || start > end || end >= size) return undefined;
  const expectedStart = first ? BigInt(first) : (BigInt(last) >= size ? 0n : size - BigInt(last));
  const expectedEnd = first && last && BigInt(last) < size ? BigInt(last) : size - 1n;
  return start === expectedStart && end === expectedEnd ? end - start + 1n : undefined;
}

function enforceRangeLength(body: ReadableStream<Uint8Array>, expected: bigint): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let length = 0n;
  return new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const part = await reader.read();
        if (part.done) {
          if (length !== expected) output.error(new Error('S3 immutable read evidence mismatch'));
          else output.close();
        } else {
          length += BigInt(part.value.byteLength);
          if (length > expected) {
            void reader.cancel().catch(() => {});
            output.error(new Error('S3 immutable read evidence mismatch'));
          } else output.enqueue(part.value);
        }
      } catch (error) { output.error(error); }
    },
    cancel() { return reader.cancel(); }
  }, { highWaterMark: 0 });
}

/**
 * Reads require a strong, opaque publication ETag. A successful response without
 * the same ETag is rejected; 412 is returned unchanged and never retried.
 * An ETag is not a version ID: callers must prevent key reuse after deletion and
 * gate cleanup independently. DELETE here is unconditional. Provider qualification
 * must establish atomic conditional writes and reads; mocks cannot prove this.
 */
export function createImmutableS3Reader(objects: ReturnType<typeof createS3Objects>) {
  function validate(reference: ImmutableS3Reference) {
    if (!reference || typeof reference.etag !== 'string' || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(reference.etag)) {
      throw new Error('Invalid S3 immutable reference');
    }
    return { key: reference.key, etag: reference.etag };
  }
  return {
    async get(reference: ImmutableS3Reference, options: { maxResponseBytes: number; signal?: AbortSignal; range?: string }) {
      const { key, etag } = validate(reference);
      const result = await objects.get(key, { maxResponseBytes: options.maxResponseBytes, signal: options.signal, range: options.range, ifMatch: etag });
      if (result.status === 200 || result.status === 206) {
        const expected = options.range === undefined ? undefined : rangeLength(options.range, result.contentRange);
        if (result.etag !== etag || (options.range === undefined
          ? result.status !== 200
          : result.status !== 206 || expected === undefined)) {
          void result.body.cancel().catch(() => {});
          throw new Error('S3 immutable read evidence mismatch');
        }
        if (expected !== undefined) return { ...result, body: enforceRangeLength(result.body, expected) };
      }
      return result;
    },
    async head(reference: ImmutableS3Reference, options: { signal?: AbortSignal } = {}) {
      const { key, etag } = validate(reference);
      const result = await objects.head(key, { signal: options.signal, ifMatch: etag });
      if (result.status === 200 && result.etag !== etag) throw new Error('S3 immutable read evidence mismatch');
      return result;
    },
  };
}
