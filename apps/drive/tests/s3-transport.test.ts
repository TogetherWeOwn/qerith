import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
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

test('captures operation metadata and cancellation binding before signing', async () => {
  let sent: Request | undefined;
  const original = new AbortController();
  const replacement = new AbortController();
  const input = { method: 'PUT' as 'PUT' | 'POST', key: 'key', body: new Uint8Array([1]), maxResponseBytes: 2, signal: original.signal };
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async (value) => {
    sent = value as Request;
    return new Response('123');
  } });
  const pending = request(input);
  input.method = 'POST';
  input.maxResponseBytes = 100;
  input.signal = replacement.signal;
  await assert.rejects(pending, /exceeds limit/);
  assert.equal(sent?.method, 'PUT');

  const stalled = createS3Transport(config, { timeoutMs: 1000, fetch: async () => new Promise<Response>(() => {}) });
  const next = stalled(input);
  input.signal = original.signal;
  replacement.abort(new Error('original binding'));
  await assert.rejects(next, /original binding/);
});

test('ready empty chunks yield to cancellation and respect the deadline', async () => {
  let pulls = 0;
  const stream = () => new ReadableStream<Uint8Array>({ pull(controller) {
    pulls++;
    controller.enqueue(new Uint8Array());
  } });
  const request = createS3Transport(config, { timeoutMs: 200, fetch: async () => new Response(stream()) });
  await assert.rejects(request(operation), /timed out/);
  assert.ok(pulls > 0);
  pulls = 0;
  const controller = new AbortController();
  const cancelRequest = createS3Transport(config, { timeoutMs: 1000, fetch: async () => {
    setTimeout(() => controller.abort(new Error('cancelled ready stream')), 0);
    return new Response(stream());
  } });
  await assert.rejects(cancelRequest({ ...operation, signal: controller.signal }), /cancelled ready stream/);
  assert.ok(pulls > 0);
});

test('frozen clock still yields ready chunks to timer cancellation', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { createS3Transport } from './src/lib/server/s3/transport.ts';
    Object.defineProperty(performance, 'now', { value: () => 0 });
    let pulls = 0;
    const controller = new AbortController();
    const request = createS3Transport(${JSON.stringify(config)}, { timeoutMs: 1000, fetch: async () => {
      setTimeout(() => controller.abort(new Error('timer cancellation')), 0);
      return new Response(new ReadableStream({ pull(stream) {
        if (++pulls <= 8192) stream.enqueue(new Uint8Array());
        else stream.close();
      } }));
    } });
    await assert.rejects(request({ method: 'GET', key: 'x', maxResponseBytes: 8, signal: controller.signal }), /timer cancellation/);
    assert.ok(pulls > 0 && pulls <= 8192);
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});

test('reads a highly fragmented bounded response', async () => {
  let remaining = 16384;
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async () =>
    new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (remaining-- > 0) controller.enqueue(new Uint8Array([1]));
      else controller.close();
    } }))
  });
  const result = await request({ ...operation, maxResponseBytes: 16384 });
  assert.equal(result.body.length, 16384);
  assert.ok(result.body.every((byte) => byte === 1));
});

test('cancellation at the fetch boundary does not leak unhandled rejections', () => {
  const script = `
    import { createS3Transport } from './src/lib/server/s3/transport.ts';
    const controller = new AbortController();
    const request = createS3Transport(${JSON.stringify(config)}, { timeoutMs: 1000, fetch: async () => {
      const stream = new ReadableStream({ start(s) { queueMicrotask(() => { controller.abort(new Error('cancelled')); s.error(new Error('stream failed')); }); } });
      return new Response(stream);
    } });
    await request({ method: 'GET', key: 'x', maxResponseBytes: 8, signal: controller.signal }).then(() => { throw new Error('unexpected success'); }, () => {});
    await new Promise(resolve => setTimeout(resolve, 20));
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr || String(child.error));
});

test('cancels response bodies abandoned at the fetch boundary', { timeout: 5000 }, async () => {
  for (const timing of ['before-reader', 'late-response'] as const) {
    const controller = new AbortController();
    let cancelled = 0;
    let release!: (response: Response) => void;
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => { dispatched = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; return Promise.reject(new Error('cleanup failed')); } }));
    const request = createS3Transport(config, { timeoutMs: 1000, fetch: () => {
      dispatched();
      return new Promise<Response>((resolve) => { release = resolve; });
    } });
    const pending = request({ ...operation, signal: controller.signal });
    await Promise.race([started, pending.then(() => { throw new Error('unexpected success'); })]);
    if (timing === 'before-reader') {
      release(response);
      queueMicrotask(() => controller.abort(new Error('cancelled')));
    } else controller.abort(new Error('cancelled'));
    await assert.rejects(pending, /cancelled/);
    if (timing === 'late-response') release(response);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(cancelled, 1, timing);
  }
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
