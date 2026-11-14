import assert from 'node:assert/strict';
import test from 'node:test';
import { createS3Transport } from '../src/lib/server/s3/transport';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };
const fixedTime = () => new Date('2013-05-24T00:00:00Z');
const operation = { method: 'GET' as const, key: 'folder/a +%/é', maxResponseBytes: 8 };

test('signs and sends the exact encoded key on the fixed authority', async () => {
  let sent: Request | undefined;
  const request = createS3Transport(config, { timeoutMs: 1000, now: fixedTime, fetch: async (input) => {
    sent = input as Request;
    return new Response('ok');
  } });
  const result = await request({ ...operation, query: { prefix: 'a/b +' } });
  assert.equal(sent?.url, 'https://storage.example/test-bucket/folder/a%20%2B%25/%C3%A9?prefix=a%2Fb%20%2B');
  assert.equal(sent?.redirect, 'manual');
  assert.match(sent?.headers.get('authorization') ?? '', /AWS4-HMAC-SHA256/);
  assert.equal(new TextDecoder().decode(result.body), 'ok');
});

test('rejects dot segments and HTTP fixtures before any request', async () => {
  let count = 0;
  const transport = async () => { count++; return new Response(); };
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: transport });
  for (const key of ['.', '..', 'a/./b', 'a/../b']) await assert.rejects(request({ ...operation, key }), /key/);
  assert.throws(() => createS3Transport({ ...config, endpoint: 'http://localhost:9000', allowLocalHttp: true }, { timeoutMs: 1000, fetch: transport }), /HTTPS/);
  assert.equal(count, 0);
});

test('snapshots and hashes a 16 MiB body, and rejects larger bodies', async () => {
  let sent: Request | undefined;
  const request = createS3Transport(config, { timeoutMs: 10000, now: fixedTime, fetch: async (input) => {
    sent = input as Request;
    return new Response();
  } });
  const body = new Uint8Array(16 * 1024 * 1024);
  body[0] = 42;
  const pending = request({ ...operation, method: 'PUT', body });
  body[0] = 9;
  await pending;
  const bytes = new Uint8Array(await sent!.arrayBuffer());
  assert.equal(bytes.length, 16 * 1024 * 1024);
  assert.equal(bytes[0], 42);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  assert.equal(sent!.headers.get('x-amz-content-sha256'), Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''));
  await assert.rejects(request({ ...operation, method: 'PUT', body: new Uint8Array(16 * 1024 * 1024 + 1) }), /part limit/);
});

test('snapshots Buffer bodies before asynchronous signing', async () => {
  let sent: Request | undefined;
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async (input) => {
    sent = input as Request;
    return new Response();
  } });
  const body = Buffer.from([42]);
  const pending = request({ ...operation, method: 'PUT', body });
  body[0] = 9;
  await pending;
  assert.deepEqual(new Uint8Array(await sent!.arrayBuffer()), new Uint8Array([42]));
});

test('handles bucket requests, conditional responses, and fragmented bodies', async () => {
  let sent: Request | undefined;
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async (input) => {
    sent = input as Request;
    if (sent.url.endsWith('/')) return new Response(null, { status: 304 });
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array([i]));
      controller.close();
    } }));
  } });
  assert.equal((await request({ ...operation, key: '' })).status, 304);
  assert.equal(sent?.url, 'https://storage.example/test-bucket/');
  assert.deepEqual((await request(operation)).body, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
});

test('returns compact backing buffers for small and empty responses', async () => {
  let count = 0;
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async () =>
    ++count === 1 ? new Response('ok') : new Response(null)
  });
  const limit = 16 * 1024 * 1024;
  const small = await request({ ...operation, maxResponseBytes: limit });
  assert.deepEqual(small.body, new TextEncoder().encode('ok'));
  assert.equal(small.body.buffer.byteLength, 2);
  const empty = await request({ ...operation, method: 'HEAD', maxResponseBytes: limit });
  assert.equal(empty.body.byteLength, 0);
  assert.equal(empty.body.buffer.byteLength, 0);
});

test('rejects redirects and bounded response overflow with one attempt', async () => {
  let count = 0;
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async () => {
    count++;
    return count === 1 ? new Response(null, { status: 302, headers: { location: 'https://other.example' } }) : new Response('12345');
  } });
  await assert.rejects(request(operation), /redirect/);
  await assert.rejects(request({ ...operation, maxResponseBytes: 4 }), /exceeds limit/);
  assert.equal(count, 2);
});

test('times out stalled fetch and response streams and honors cancellation', async () => {
  let count = 0;
  const request = createS3Transport(config, { timeoutMs: 20, fetch: async () => {
    count++;
    if (count === 1) return new Promise<Response>(() => {});
    return new Response(new ReadableStream({ pull() { return new Promise<void>(() => {}); } }));
  } });
  await assert.rejects(request(operation), /timed out/);
  await assert.rejects(request(operation), /timed out/);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(request({ ...operation, signal: controller.signal }), /cancelled/);
  assert.equal(count, 2);
});
