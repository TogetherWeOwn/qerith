import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createS3Objects } from './objects';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };

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
