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
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Fixed-authority, single-attempt transport. HTTP fixtures are not supported by the signer. */
export function createS3Transport(config: S3Config, options: TransportOptions) {
  const settings = validateConfig(config);
  if (new URL(settings.endpoint).protocol !== 'https:') throw new Error('S3 signer requires HTTPS');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid S3 timeout');
  const signer = createS3Signer({ ...settings, fetch: options.fetch, now: options.now });

  return async function request(operation: Operation): Promise<{ status: number; headers: Headers; body: Uint8Array }> {
    if (!Number.isSafeInteger(operation.maxResponseBytes) || operation.maxResponseBytes < 0 || operation.maxResponseBytes > MAX_PART_BYTES) {
      throw new Error('Invalid S3 response limit');
    }
    if (operation.key.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new Error('Unsupported S3 object key');
    }
    if (operation.body && operation.body.byteLength > MAX_PART_BYTES) throw new Error('S3 request body exceeds part limit');
    const path = operation.key.split('/').map(encode).join('/');
    const query = Object.entries(operation.query ?? {}).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
    const url = `${settings.endpoint}/${settings.bucket}/${path}${query ? `?${query}` : ''}`;
    const headers = new Headers(operation.headers);
    if (headers.has('x-amz-content-sha256')) throw new Error('S3 payload hash is managed by transport');
    // Snapshot once before hashing: the signer takes its own snapshot for the signed Request.
    const body = operation.body && new Uint8Array(operation.body);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(operation.signal?.reason);
    if (operation.signal?.aborted) forwardAbort();
    else operation.signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('S3 request timed out')), options.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const hash = body ? await abortable(crypto.subtle.digest('SHA-256', body), controller.signal) : undefined;
      headers.set('x-amz-content-sha256', hash ? Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') : EMPTY_HASH);
      if (controller.signal.aborted) throw controller.signal.reason;
      const signed = await abortable(signer.sign(url, {
        method: operation.method, headers, body, signal: controller.signal, redirect: 'manual'
      }), controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      const transport = options.fetch;
      const response = await abortable(transport(signed), controller.signal);
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        void response.body?.cancel().catch(() => {});
        throw new Error('S3 redirects are not allowed');
      }
      const result = new Uint8Array(operation.maxResponseBytes);
      let length = 0;
      reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const part = await abortable(reader.read(), controller.signal);
          if (part.done) break;
          if (part.value.byteLength > operation.maxResponseBytes - length) throw new Error('S3 response exceeds limit');
          result.set(part.value, length);
          length += part.value.byteLength;
        }
      }
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
      operation.signal?.removeEventListener('abort', forwardAbort);
    }
  };
}
