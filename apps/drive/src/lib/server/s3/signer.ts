import { AwsClient } from 'aws4fetch';

export interface S3SignerOptions {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  fetch: typeof fetch;
  now?: () => Date;
}

function canonicalComponent(value: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(value)).replace(/[!'()*]/g, (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
  } catch {
    throw new Error('Unsupported S3 URL encoding');
  }
}

export function createS3Signer(options: S3SignerOptions) {
  if (!options.accessKeyId || !options.secretAccessKey || !options.region) {
    throw new Error('S3 signing credentials and region are required');
  }
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    sessionToken: options.sessionToken,
    service: 's3',
    region: options.region
  });

  async function sign(url: string, init: RequestInit = {}): Promise<Request> {
    const pathAndAuthority = url.split(/[?#]/, 1)[0];
    if (/[\x00-\x20\x7f]/.test(url) || pathAndAuthority.includes('\\') || /\/(?:\.|%2e){1,2}(?=\/|$)/i.test(pathAndAuthority)) {
      throw new Error('Unsupported S3 URL');
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname.includes('+') || /%2f/i.test(parsed.pathname)) {
      throw new Error('Unsupported S3 URL');
    }
    if (parsed.pathname.split('/').some((part) => canonicalComponent(part) !== part)) {
      throw new Error('Unsupported S3 URL encoding');
    }
    for (const pair of parsed.search ? parsed.search.slice(1).split('&') : []) {
      if (!pair) throw new Error('Unsupported S3 query parameters');
      const separator = pair.indexOf('=');
      const key = separator < 0 ? pair : pair.slice(0, separator);
      const value = separator < 0 ? '' : pair.slice(separator + 1);
      if (canonicalComponent(key) !== key || canonicalComponent(value) !== value) {
        throw new Error('Unsupported S3 query encoding');
      }
    }
    const headers = new Headers(init.headers);
    for (const name of ['authorization', 'host', 'connection', 'user-agent', 'content-length', 'transfer-encoding', 'trailer', 'expect', 'x-amzn-trace-id']) {
      if (headers.has(name)) throw new Error('Unsupported S3 headers');
    }
    const payloadHash = headers.get('x-amz-content-sha256') ?? '';
    if (!/^(?:[0-9a-f]{64}|UNSIGNED-PAYLOAD)$/.test(payloadHash)) throw new Error('Valid S3 payload hash is required');
    if (parsed.search.includes('+')) throw new Error('Unsupported S3 query parameters');
    const keys = new Set<string>();
    for (const key of parsed.searchParams.keys()) {
      if (!key || keys.has(key)) throw new Error('Unsupported S3 query parameters');
      keys.add(key);
    }
    if (init.keepalive && init.body != null) throw new Error('S3 keepalive requests with a body are unsupported');
    let body = init.body;
    if (body != null && typeof body !== 'string' && !(body instanceof Blob) &&
        !(body instanceof URLSearchParams) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
      throw new Error('Unsupported S3 request body');
    }
    if (body instanceof URLSearchParams) body = new URLSearchParams(body);
    else if (body instanceof ArrayBuffer) body = body.slice(0);
    else if (ArrayBuffer.isView(body)) body = new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
    const request = new Request(parsed, { ...init, headers, redirect: 'manual', duplex: 'half' } as RequestInit);
    if (request.method !== request.method.toUpperCase()) throw new Error('Unsupported S3 method');
    const datetime = (options.now?.() ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
    return client.sign(parsed, {
      method: request.method, headers: request.headers, body, signal: request.signal,
      cache: request.cache, credentials: request.credentials, integrity: request.integrity,
      keepalive: request.keepalive, mode: request.mode, referrer: request.referrer,
      referrerPolicy: request.referrerPolicy, redirect: 'manual', aws: { datetime, allHeaders: true }
    });
  }

  return {
    sign,
    async fetch(url: string, init: RequestInit = {}): Promise<Response> {
      const transport = options.fetch;
      return transport(await sign(url, init));
    }
  };
}
