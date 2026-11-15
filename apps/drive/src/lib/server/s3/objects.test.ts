import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createS3Objects } from './objects';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };

test('GET streams a range with signed validators and preserves response metadata', async () => {
  let sent: Request | undefined;
  const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async (input) => {
    sent = input as Request;
    return new Response('abc', { status: 206, headers: { etag: '"v1"', 'content-length': '3', 'content-range': 'bytes 1-3/5' } });
  } });
  const result = await objects.get('folder/a +%/é', { maxResponseBytes: 3, range: 'bytes=1-3', ifMatch: '"v1"', ifNoneMatch: '"v0"', ifRange: '"v1"' });
  assert.equal(result.status, 206);
  assert.equal(result.etag, '"v1"');
  assert.equal(result.contentRange, 'bytes 1-3/5');
  assert.equal(result.contentLength, '3');
  assert.equal(await new Response(result.body).text(), 'abc');
  assert.equal(sent?.headers.get('range'), 'bytes=1-3');
  assert.equal(sent?.headers.get('if-match'), '"v1"');
  assert.equal(sent?.headers.get('if-none-match'), '"v0"');
  assert.equal(sent?.headers.get('if-range'), '"v1"');
  assert.match(sent?.headers.get('authorization') ?? '', /AWS4-HMAC-SHA256/);
});

test('GET rejects encoded success bodies before handoff and cancels them', async () => {
  for (const status of [200, 206]) {
    for (const encoding of ['gzip', 'br', 'deflate', 'unknown', 'gzip, br', 'identity', '']) {
      let cancelled = false;
      let pulls = 0;
      let calls = 0;
      const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async () => {
        calls++;
        return new Response(new ReadableStream({
          pull(controller) { pulls++; controller.enqueue(new Uint8Array([0, 128, 255])); },
          cancel() { cancelled = true; }
        }, { highWaterMark: 0 }), {
          status, headers: { 'content-encoding': encoding, 'content-length': '3', 'content-range': 'bytes 0-2/3' }
        });
      } });
      await assert.rejects(objects.get('key', { maxResponseBytes: 3 }), { message: 'S3 request failed' });
      assert.equal(pulls, 0);
      assert.equal(cancelled, true);
      assert.equal(calls, 1);
    }
  }
});

test('GET preserves unencoded binary full and range bodies', async () => {
  const bytes = new Uint8Array([0, 128, 255, 10]);
  for (const status of [200, 206]) {
    const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async () => new Response(bytes, { status }) });
    const result = await objects.get('key', { maxResponseBytes: bytes.length, ...(status === 206 ? { range: 'bytes=0-3' } : {}) });
    if (result.status !== 200 && result.status !== 206) throw new Error('Expected streamed response');
    assert.equal(result.status, status);
    assert.deepEqual(new Uint8Array(await new Response(result.body).arrayBuffer()), bytes);
  }
});

test('GET forwards If-Range on a 400 without retrying', async () => {
  let calls = 0;
  let sent: Request | undefined;
  let cancelled = false;
  const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async (input) => {
    calls++;
    sent = input as Request;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 400 });
  } });
  await assert.rejects(objects.get('key', { maxResponseBytes: 4, range: 'bytes=0-3', ifRange: '"v1"' }), { message: 'S3 request failed with status 400' });
  assert.equal(sent?.headers.get('if-range'), '"v1"');
  assert.equal(sent?.headers.get('range'), 'bytes=0-3');
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test('GET preserves encoded 304 metadata', async () => {
  const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async () => new Response(null, {
    status: 304, headers: { 'content-encoding': 'gzip', etag: '"v1"', 'content-length': '3' }
  }) });
  assert.deepEqual(await objects.get('key', { maxResponseBytes: 0 }), {
    status: 304, etag: '"v1"', contentLength: '3', contentRange: null
  });
});

test('GET cancels non-success bodies and reports conditional and range statuses', async () => {
  for (const status of [304, 404, 412, 416, 503]) {
    let cancelled = false;
    const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async () => new Response(
      status === 304 ? null : new ReadableStream({ cancel() { cancelled = true; } }),
      { status, headers: { etag: '"v1"', 'content-range': 'bytes */5' } }
    ) });
    if (status === 503) await assert.rejects(objects.get('key', { maxResponseBytes: 0 }), { message: 'S3 request failed with status 503' });
    else assert.equal((await objects.get('key', { maxResponseBytes: 0 })).status, status);
    if (status !== 304) assert.equal(cancelled, true);
  }
});

test('GET enforces streaming limits and redacts invalid input and cancellation', async () => {
  let calls = 0;
  const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async () => { calls++; return new Response('abcd'); } });
  const result = await objects.get('key', { maxResponseBytes: 3 });
  if (result.status !== 200 && result.status !== 206) throw new Error('Expected streamed response');
  await assert.rejects(new Response(result.body).text(), { message: 'S3 response exceeds limit' });
  await assert.rejects(objects.get('key', { maxResponseBytes: 3, range: 'secret\nvalue' }), { message: 'S3 request failed' });
  await assert.rejects(objects.get('a/../b', { maxResponseBytes: 3 }), { message: 'Invalid S3 object key' });
  const controller = new AbortController();
  controller.abort('secret reason');
  await assert.rejects(objects.get('key', { maxResponseBytes: 3, signal: controller.signal }), { message: 'S3 request cancelled' });
  assert.equal(calls, 1);
});

test('HEAD signs the opaque key, forwards validators and preserves zero length and quoted ETag', async () => {
  let sent: Request | undefined;
  const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async (input) => {
    sent = input as Request;
    return new Response(null, { headers: { etag: '"opaque"', 'content-length': '0' } });
  } });
  const result = await objects.head('folder/a +%/é', { ifMatch: '"old"', ifNoneMatch: '"other"' });
  assert.deepEqual(result, { status: 200, etag: '"opaque"', contentLength: '0' });
  assert.equal(sent?.method, 'HEAD');
  assert.equal(sent?.url, 'https://storage.example/test-bucket/folder/a%20%2B%25/%C3%A9');
  assert.equal(sent?.headers.get('if-match'), '"old"');
  assert.equal(sent?.headers.get('if-none-match'), '"other"');
  assert.match(sent?.headers.get('authorization') ?? '', /AWS4-HMAC-SHA256/);
});

test('HEAD distinguishes missing and conditional responses without parsing error bodies', async () => {
  for (const status of [304, 404, 412]) {
    const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async () => new Response(null, { status, headers: { etag: '"v1"' } }) });
    assert.deepEqual(await objects.head('key'), { status, etag: '"v1"' });
  }
});

test('HEAD redacts provider and transport errors and does not retry', async () => {
  let calls = 0;
  const failure = createS3Objects(config, { timeoutMs: 1000, fetch: async () => {
    calls++;
    throw new Error('secret signed-url');
  } });
  await assert.rejects(failure.head('key'), { message: 'S3 request failed' });
  assert.equal(calls, 1);
  const status = createS3Objects(config, { timeoutMs: 1000, fetch: async () => new Response(null, { status: 503 }) });
  await assert.rejects(status.head('key'), { message: 'S3 request failed with status 503' });
});

test('PUT sends zero bytes and DELETE makes one signed request', async () => {
  const sent: Request[] = [];
  const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async (input) => {
    sent.push(input as Request);
    return new Response(null, { status: 200, headers: { etag: '"receipt"' } });
  } });
  assert.deepEqual(await objects.put('empty', new Uint8Array()), { etag: '"receipt"' });
  assert.deepEqual(await objects.delete('empty'), { etag: '"receipt"' });
  assert.deepEqual(sent.map((request) => request.method), ['PUT', 'DELETE']);
  assert.equal((await sent[0].arrayBuffer()).byteLength, 0);
  assert.match(sent[0].headers.get('authorization') ?? '', /AWS4-HMAC-SHA256/);
});

test('mutations distinguish rejected and uncertain outcomes without leaking details or retrying', async () => {
  let calls = 0;
  const rejected = createS3Objects(config, { timeoutMs: 1000, fetch: async () => {
    calls++; return new Response('secret provider message', { status: 403 });
  } });
  await assert.rejects(rejected.delete('key'), { message: 'S3 request failed with status 403' });
  const uncertain = createS3Objects(config, { timeoutMs: 1000, fetch: async () => {
    calls++; throw new Error('secret signed request');
  } });
  await assert.rejects(uncertain.put('key', new Uint8Array()), { message: 'S3 mutation outcome uncertain' });
  for (const status of [408, 500]) {
    const serverError = createS3Objects(config, { timeoutMs: 1000, fetch: async () => new Response('error', { status }) });
    await assert.rejects(serverError.delete('key'), { message: 'S3 mutation outcome uncertain' });
  }
  await assert.rejects(uncertain.put('key', new Uint8Array(16 * 1024 * 1024 + 1)), /part limit/);
  assert.equal(calls, 2);
});

test('cancelled and oversized mutation responses do not imply rollback', async () => {
  const controller = new AbortController();
  let calls = 0;
  const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async () => {
    calls++;
    controller.abort('private reason');
    return new Response();
  } });
  await assert.rejects(objects.delete('key', controller.signal), { message: 'S3 mutation outcome uncertain' });
  await assert.rejects(objects.delete('key', controller.signal), { message: 'S3 request cancelled' });
  assert.equal(calls, 1);
  const oversized = createS3Objects(config, { timeoutMs: 1000, fetch: async () => new Response('x'.repeat(8193), { status: 403 }) });
  await assert.rejects(oversized.delete('key'), { message: 'S3 mutation outcome uncertain' });
});

test('HEAD cancels without exposing abort reasons and rejects unsafe dot segments', async () => {
  let calls = 0;
  const objects = createS3Objects(config, { timeoutMs: 1000, fetch: async () => { calls++; return new Response(); } });
  const controller = new AbortController();
  controller.abort(new Error('secret reason'));
  await assert.rejects(objects.head('key', { signal: controller.signal }), { message: 'S3 request cancelled' });
  await assert.rejects(objects.head('key', { ifMatch: 'secret\nvalue' }), { message: 'S3 request failed' });
  for (const key of ['', 'a/../b', 'a/./b', '\ud800']) {
    await assert.rejects(objects.head(key), { message: 'Invalid S3 object key' });
    await assert.rejects(objects.delete(key), { message: 'Invalid S3 object key' });
    await assert.rejects(objects.put(key, new Uint8Array()), { message: 'Invalid S3 object key' });
  }
  assert.equal(calls, 0);
});
