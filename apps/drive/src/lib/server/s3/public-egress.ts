import { readBoundedBody } from '../bounded-io';
import { s3Address, type S3Config } from './config';

const publicDns = 'https://cloudflare-dns.com/dns-query';
const dnsName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function publicName(host: string): boolean {
  const labels = host.split('.');
  return host.length <= 253 && labels.length >= 2 && labels.every(label => dnsName.test(label)) &&
    /[a-z]/.test(labels.at(-1)!) &&
    !/(?:^|\.)(?:localhost|local|internal|home\.arpa|test|invalid|example|onion)$/.test(host);
}

export function ownerStorageOrigin(config: S3Config, driveOrigin: string): string {
  const endpoint = new URL(config.endpoint);
  const target = new URL(s3Address(config).origin);
  if (target.protocol !== 'https:' || !publicName(endpoint.hostname) || !publicName(target.hostname) ||
      target.hostname === new URL(driveOrigin).hostname) throw new Error('Invalid storage host');
  return target.origin;
}

function publicAddress(address: string, type: 1 | 28): boolean {
  if (type === 1) {
    if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(address)) return false;
    const [a, b, c, d] = address.split('.').map(Number);
    return a > 0 && a < 224 && b <= 255 && c <= 255 && d <= 255 && a !== 10 && a !== 127 &&
      !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) &&
      !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
  }
  if (!/^[a-f0-9:]+$/i.test(address)) return false;
  try {
    const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    const [first, second] = canonical.split(':', 2).map(part => parseInt(part || '0', 16));
    return first >= 0x2000 && first < 0x4000 && first !== 0x2002 && first !== 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  } catch { return false; }
}

async function publicAnswers(host: string, type: 1 | 28, signal: AbortSignal, send: typeof fetch) {
  const url = new URL(publicDns);
  url.searchParams.set('name', host);
  url.searchParams.set('type', String(type));
  const response = await send(new Request(url, { headers: { accept: 'application/dns-json' }, redirect: 'manual', signal }));
  if (response.status !== 200 || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Storage DNS unavailable');
  }
  const body = await readBoundedBody(response.body, { signal, timeoutMs: 2000, maxBytes: 8192, maxReads: 128 });
  const data = body && JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  if (data?.Status !== 0 || data.TC === true || data.Question?.length !== 1 ||
      data.Question[0]?.name !== `${host}.` || data.Question[0]?.type !== type ||
      (data.Answer !== undefined && !Array.isArray(data.Answer))) throw new Error('Storage DNS unavailable');
  let count = 0;
  for (const answer of data.Answer ?? []) {
    const record = typeof answer?.data === 'string' && answer.data;
    if (answer?.type === 5 && record && publicName(record.toLowerCase().replace(/\.$/, ''))) continue;
    if (answer?.type !== type || !record || !publicAddress(record, type)) throw new Error('Storage DNS denied');
    count++;
  }
  return count;
}

/** DNS screening covers every effective host. The deployed Worker's strictly public fetch also
 * enforces public routing at connection time, independently of these DNS answers. */
export function ownerStorageFetch(origin: string, send: typeof fetch = fetch): typeof fetch {
  const { hostname } = new URL(origin);
  let check: Promise<unknown> | undefined;
  return async (request) => {
    if (!(request instanceof Request) || new URL(request.url).origin !== origin || request.redirect !== 'manual') {
      throw new Error('Storage destination denied');
    }
    request.signal.throwIfAborted();
    check ??= (async () => {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(2200)]);
      const [a, aaaa] = await Promise.all([publicAnswers(hostname, 1, signal, send), publicAnswers(hostname, 28, signal, send)]);
      if (a + aaaa === 0) throw new Error('Storage DNS unavailable');
    })();
    await check;
    request.signal.throwIfAborted();
    return send(request, { redirect: 'manual', cache: 'no-store' });
  };
}
