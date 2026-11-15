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

function abortable<T>(promise: Promise<T>, signal: AbortSignal, discard?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => { aborted = true; reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (aborted) discard?.(value);
        else resolve(value);
      },
      (error) => { signal.removeEventListener('abort', abort); reject(error); }
    );
  });
}

function cancelResponse(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** Fixed-authority, single-attempt transport. HTTP fixtures are not supported by the signer. */
export function createS3Transport(config: S3Config, options: TransportOptions) {
  const settings = validateConfig(config);
  if (new URL(settings.endpoint).protocol !== 'https:') throw new Error('S3 signer requires HTTPS');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid S3 timeout');
  const signer = createS3Signer({ ...settings, fetch: options.fetch, now: options.now });

  async function execute(operation: Operation, streaming: boolean): Promise<{ status: number; headers: Headers; body: Uint8Array | ReadableStream<Uint8Array> }> {
    const { method, key, query: queryParams, signal, maxResponseBytes, body: inputBody, headers: inputHeaders } = operation;
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0 || (!streaming && maxResponseBytes > MAX_PART_BYTES)) {
      throw new Error('Invalid S3 response limit');
    }
    if (streaming && (method !== 'GET' || inputBody)) throw new Error('S3 streaming requires GET');
    if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw new Error('Unsupported S3 object key');
    }
    const bodyLength = inputBody?.byteLength;
    if (inputBody && (bodyLength === undefined || !Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_PART_BYTES)) {
      throw new Error('S3 request body exceeds part limit');
    }
    const path = key.split('/').map(encode).join('/');
    const query = Object.entries(queryParams ?? {}).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
    const url = `${settings.endpoint}/${settings.bucket}/${path}${query ? `?${query}` : ''}`;
    const headers = new Headers(inputHeaders);
    if (headers.has('x-amz-content-sha256')) throw new Error('S3 payload hash is managed by transport');
    // Snapshot once before hashing: the signer takes its own snapshot for the signed Request.
    const body = inputBody && new Uint8Array(new Uint8Array(inputBody.buffer, inputBody.byteOffset, bodyLength));
    if (body && (body.byteLength !== bodyLength || body.byteLength > MAX_PART_BYTES)) {
      throw new Error('S3 request body exceeds part limit');
    }
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
    let response: Response | undefined;
    let handedOff = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    };
    try {
      const hash = body ? await abortable(crypto.subtle.digest('SHA-256', body), controller.signal) : undefined;
      headers.set('x-amz-content-sha256', hash ? Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') : EMPTY_HASH);
      checkAbort();
      const signed = await abortable(signer.sign(url, {
        method, headers, body, signal: controller.signal, redirect: 'manual'
      }), controller.signal);
      checkAbort();
      const transport = options.fetch;
      response = await abortable(transport(signed), controller.signal, cancelResponse);
      checkAbort();
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        throw new Error('S3 redirects are not allowed');
      }
      if (streaming) {
        reader = response.body?.getReader();
        let length = 0;
        let chunksSinceYield = 0;
        let yieldAt = performance.now() + 4;
        let finished = false;
        let onAbort: () => void;
        const finish = () => {
          if (finished) return;
          finished = true;
          controller.signal.removeEventListener('abort', onAbort);
          cleanup();
        };
        const stream = new ReadableStream<Uint8Array>({
          start(output) {
            onAbort = () => {
              if (finished) return;
              finish();
              void reader?.cancel().catch(() => {});
              output.error(new Error('S3 stream aborted or timed out'));
            };
            controller.signal.addEventListener('abort', onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
          },
          async pull(output) {
            try {
              checkAbort();
              if (++chunksSinceYield >= 1024 || performance.now() >= yieldAt) {
                await abortable(new Promise<void>((resolve) => setTimeout(resolve, 0)), controller.signal);
                chunksSinceYield = 0;
                yieldAt = performance.now() + 4;
              }
              const part = reader ? await abortable(reader.read(), controller.signal) : { done: true as const, value: undefined };
              checkAbort();
              if (finished) return;
              if (part.done) {
                finish();
                output.close();
              } else if (part.value.byteLength > maxResponseBytes - length) {
                finish();
                controller.abort();
                void reader?.cancel().catch(() => {});
                output.error(new Error('S3 response exceeds limit'));
              } else {
                length += part.value.byteLength;
                output.enqueue(part.value);
              }
            } catch {
              if (finished) return;
              finish();
              controller.abort();
              void reader?.cancel().catch(() => {});
              output.error(new Error('S3 stream failed'));
            }
          },
          cancel() {
            finish();
            controller.abort();
            void reader?.cancel().catch(() => {});
          }
        }, { highWaterMark: 0 });
        handedOff = true;
        return { status: response.status, headers: response.headers, body: stream };
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
      else if (response) cancelResponse(response);
      if (streaming) throw new Error('S3 stream request failed');
      throw error;
    } finally {
      if (!handedOff) cleanup();
    }
  }

  const request = async (operation: Operation) =>
    await execute(operation, false) as { status: number; headers: Headers; body: Uint8Array };
  request.stream = async (operation: Omit<Operation, 'method' | 'body'> & { method: 'GET' }) => {
    try {
      return await execute(operation, true) as { status: number; headers: Headers; body: ReadableStream<Uint8Array> };
    } catch {
      throw new Error('S3 stream request failed');
    }
  };
  return request;
}
