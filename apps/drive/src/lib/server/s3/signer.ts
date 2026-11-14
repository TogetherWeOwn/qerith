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

  async function sign(url: string | URL, init: RequestInit = {}): Promise<Request> {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.pathname.includes('+') || /%2f/i.test(parsed.pathname)) {
      throw new Error('Unsupported S3 URL');
    }
    const headers = new Headers(init.headers);
    if (headers.has('authorization') || headers.has('host')) throw new Error('Unsupported S3 headers');
    const keys = new Set<string>();
    for (const key of parsed.searchParams.keys()) {
      if (!key || keys.has(key)) throw new Error('Unsupported S3 query parameters');
      keys.add(key);
    }
    const datetime = (options.now?.() ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');
    return client.sign(parsed, { ...init, redirect: 'manual', aws: { datetime, allHeaders: true } });
  }

  return {
    sign,
    async fetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
      return options.fetch(await sign(url, init));
    }
  };
}
