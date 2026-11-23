import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Agent, fetch } from 'undici'; // Locked by Wrangler.
import { readBoundedBody } from '../src/lib/server/bounded-io.ts';
import { createS3Transport } from '../src/lib/server/s3/transport.ts';
import { listingChildren, listingText, parseListingXml } from '../src/lib/server/s3/listing-xml.ts';

export const minioRelease = 'RELEASE.2025-09-07T16-13-09Z';
const minioSha256 = '7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f';

async function installMinio(path) {
  execFileSync('curl', ['--disable', '--fail', '--silent', '--location', '--proto', '=https',
    '--proto-redir', '=https', '--max-time', '90', '--max-filesize', '150000000', '--output', path,
    `https://github.com/minio/minio/releases/download/${minioRelease}/minio.linux-amd64.${minioRelease}`], { stdio: 'ignore', timeout: 95_000 });
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== minioSha256) throw new Error('MinIO binary digest mismatch');
  await chmod(path, 0o500);
}

async function localEndpoint(log) {
  const lines = createInterface({ input: log, signal: AbortSignal.timeout(20_000) });
  try {
    for await (const line of lines) {
      const endpoint = /^API: (https:\/\/127\.0\.0\.1:[1-9][0-9]{0,4})\s*$/.exec(line);
      if (endpoint) return new URL(endpoint[1]).origin;
    }
  } finally {
    lines.close();
    log.resume();
  }
  throw new Error('Loopback MinIO readiness unverified');
}

export async function withLocalMinio(dir, bucket, run) {
  const binary = join(dir, 'minio');
  await installMinio(binary);
  const certs = join(dir, 'certs');
  await mkdir(certs, { mode: 0o700 });
  const cert = join(certs, 'public.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=Drive staging fixture', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(certs, 'private.key'), '-out', cert], { stdio: 'ignore', timeout: 10_000 });
  const ca = await readFile(cert);
  const accessKeyId = randomBytes(16).toString('hex');
  const secretAccessKey = randomBytes(24).toString('hex');
  const server = spawn(binary, ['server', '--address', '127.0.0.1:0', '--console-address', '127.0.0.1:0',
    '--certs-dir', certs, '--anonymous', join(dir, 'data')], {
    env: { PATH: '/usr/bin:/bin', MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey,
      MINIO_UPDATE: 'off', MINIO_BROWSER: 'off' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.on('error', () => {}); // Startup errors close the log and fail readiness.
  const closed = new Promise(resolve => server.once('close', resolve));
  const dispatcher = new Agent({ connect: { ca } });
  try {
    const endpoint = await localEndpoint(server.stderr);
    const settings = { endpoint, bucket, region: 'us-east-1', accessKeyId, secretAccessKey };
    const bucketPath = `/${bucket}/`;
    const send = async (request) => {
      const url = new URL(request.url);
      if (url.origin !== endpoint || !url.pathname.startsWith(bucketPath)) throw new Error('Unexpected fixture S3 target');
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
      // MinIO requires a known Content-Length for signed writes.
      const body = request.body && await readBoundedBody(request.body, { signal, maxBytes: 16 * 1024 * 1024, timeoutMs: 8000 });
      if (request.body && !body) throw new Error('Unexpected fixture S3 body');
      return fetch(url, { method: request.method, headers: [...request.headers], body: body ?? undefined,
        redirect: 'error', signal, dispatcher });
    };
    const options = { fetch: send, timeoutMs: 8000, drainBufferedAbort: true };
    const request = createS3Transport(settings, options);
    const created = await request({ method: 'PUT', key: '', maxResponseBytes: 8192 });
    if (created.status !== 200) throw new Error('Disposable bucket creation failed');
    const anonymous = await send(new Request(`${endpoint}${bucketPath}?list-type=2`));
    await anonymous.body?.cancel();
    if (anonymous.status !== 403) throw new Error('Disposable bucket privacy unverified');
    return await run({ settings, options, request, send });
  } finally {
    const stopping = server.kill('SIGTERM');
    const deadline = setTimeout(() => server.kill('SIGKILL'), 5000);
    const [code] = await Promise.all([closed, dispatcher.destroy()]);
    clearTimeout(deadline);
    if (!stopping || code !== 0) throw new Error('Disposable MinIO shutdown unverified');
  }
}

export async function verifyLocalObjectExpiry(prefix, request) {
  const body = Buffer.from(`<LifecycleConfiguration><Rule><ID>smoke-expiry</ID><Filter><Prefix>${prefix}</Prefix></Filter><Status>Enabled</Status><Expiration><Days>3</Days></Expiration></Rule></LifecycleConfiguration>`);
  const query = { lifecycle: '' };
  const put = await request({ method: 'PUT', key: '', query, body, maxResponseBytes: 8192,
    headers: { 'content-md5': createHash('md5').update(body).digest('base64'), 'content-type': 'application/xml' } });
  const read = await request({ method: 'GET', key: '', query, maxResponseBytes: 8192 });
  if (put.status !== 200 || read.status !== 200) throw new Error('Local object expiry unverified');
  const root = parseListingXml(read.body, 'LifecycleConfiguration');
  const rules = listingChildren(root, 'Rule');
  if (rules.length !== 1) throw new Error('Local object expiry unverified');
  const filters = listingChildren(rules[0], 'Filter');
  const expiration = listingChildren(rules[0], 'Expiration');
  if (filters.length !== 1 || listingText(filters[0], 'Prefix') !== prefix ||
      expiration.length !== 1 || listingText(expiration[0], 'Days') !== '3' ||
      listingText(rules[0], 'Status') !== 'Enabled') throw new Error('Local object expiry unverified');
}
