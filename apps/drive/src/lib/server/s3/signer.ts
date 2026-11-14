import { AwsClient } from 'aws4fetch';

export interface S3SignerOptions {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  fetch: typeof fetch;
  now?: () => Date;
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
    if (pathAndAuthority.includes('\\') || /\/(?:\.|%2e){1,2}(?=\/|$)/i.test(pathAndAuthority)) {
      throw new Error('Unsupported S3 URL');
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname.includes('+') || /%2f/i.test(parsed.pathname)) {
      throw new Error('Unsupported S3 URL');
    }
    const headers = new Headers(init.headers);
    for (const name of ['authorization', 'host', 'connection', 'user-agent', 'content-length', 'expect', 'x-amzn-trace-id']) {
      if (headers.has(name)) throw new Error('Unsupported S3 headers');
    }
    const payloadHash = headers.get('x-amz-content-sha256') ?? '';
    if (!/^(?:[0-9a-f]{64}|UNSIGNED-PAYLOAD)$/.test(payloadHash)) throw new Error('Valid S3 payload hash is required');
    const keys = new Set<string>();
    for (const key of parsed.searchParams.keys()) {
      if (!key || keys.has(key)) throw new Error('Unsupported S3 query parameters');
      keys.add(key);
    }
    const datetime = (options.now?.() ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
    return client.sign(parsed, {
      method: init.method, headers, body: init.body, signal: init.signal,
      redirect: 'manual', aws: { datetime, allHeaders: true }
    });
  }

  return {
    sign,
    async fetch(url: string, init: RequestInit = {}): Promise<Response> {
      return options.fetch(await sign(url, init));
    }
  };
}
