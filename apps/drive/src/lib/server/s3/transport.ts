import { validateConfig, type S3Config } from './config';
import { createS3Signer } from './signer';

const MAX_PART_BYTES = 16 * 1024 * 1024;
const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

type TransportOptions = { fetch: typeof fetch; timeoutMs: number; now?: () => Date };
type Operation = {
  method: 'GET' | 'HEAD' | 'PUT' | 'POST' | 'DELETE';
  key: string;
  query?: Record<string, string>;
  headers?: HeadersInit;
  body?: Uint8Array;
  maxResponseBytes: number;
  signal?: AbortSignal;
};

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); }
    );
  });
}

/** Fixed-authority, single-attempt transport. HTTP fixtures are not supported by the signer. */
export function createS3Transport(config: S3Config, options: TransportOptions) {
  const settings = validateConfig(config);
  if (new URL(settings.endpoint).protocol !== 'https:') throw new Error('S3 signer requires HTTPS');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid S3 timeout');
  const signer = createS3Signer({ ...settings, fetch: options.fetch, now: options.now });

  return async function request(operation: Operation): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    const { method, key, query: queryParams, signal, maxResponseBytes, body: inputBody, headers: inputHeaders } = operation;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0 || maxResponseBytes > MAX_PART_BYTES) {
      throw new Error('Invalid S3 response limit');
    }
    if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new Error('Unsupported S3 object key');
    }
    if (inputBody && inputBody.byteLength > MAX_PART_BYTES) throw new Error('S3 request body exceeds part limit');
    const path = key.split('/').map(encode).join('/');
    const query = Object.entries(queryParams ?? {}).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
    const url = `${settings.endpoint}/${settings.bucket}/${path}${query ? `?${query}` : ''}`;
    const headers = new Headers(inputHeaders);
    if (headers.has('x-amz-content-sha256')) throw new Error('S3 payload hash is managed by transport');
    // Snapshot once before hashing: the signer takes its own snapshot for the signed Request.
    const body = inputBody && new Uint8Array(inputBody);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeoutError = new Error('S3 request timed out');
    const deadline = performance.now() + options.timeoutMs;
    const timer = setTimeout(() => controller.abort(timeoutError), options.timeoutMs);
    const checkAbort = () => {
      if (!controller.signal.aborted && performance.now() >= deadline) controller.abort(timeoutError);
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const hash = body ? await abortable(crypto.subtle.digest('SHA-256', body), controller.signal) : undefined;
      headers.set('x-amz-content-sha256', hash ? Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') : EMPTY_HASH);
      checkAbort();
      const signed = await abortable(signer.sign(url, {
        method, headers, body, signal: controller.signal, redirect: 'manual'
      }), controller.signal);
      checkAbort();
      const transport = options.fetch;
      const response = await abortable(transport(signed), controller.signal);
      checkAbort();
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        void response.body?.cancel().catch(() => {});
        throw new Error('S3 redirects are not allowed');
      }
      const result = new Uint8Array(maxResponseBytes);
      let length = 0;
      let yieldAt = performance.now() + 4;
      let chunksSinceYield = 0;
      reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          checkAbort();
          const part = await abortable(reader.read(), controller.signal);
          checkAbort();
          if (part.done) break;
          if (part.value.byteLength > maxResponseBytes - length) throw new Error('S3 response exceeds limit');
          result.set(part.value, length);
          length += part.value.byteLength;
          // Workers clocks can freeze between I/O turns; also bound reads independently of time.
          if (++chunksSinceYield >= 1024 || performance.now() >= yieldAt) {
            await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), controller.signal);
            chunksSinceYield = 0;
            yieldAt = performance.now() + 4;
          }
        }
      }
      checkAbort();
      // Compact partial responses so the returned body does not retain unused capacity.
      // At most one additional response-sized copy is transiently allocated.
      const responseBody = length === result.byteLength ? result : result.slice(0, length);
      return { status: response.status, headers: response.headers, body: responseBody };
    } catch (error) {
      controller.abort(error);
      if (reader) void reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  };
}
