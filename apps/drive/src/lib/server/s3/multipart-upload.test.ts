import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createMultipartUpload } from './multipart-upload';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };

test('uploads a part once with opaque identifiers and preserves its quoted ETag', async () => {
  let sent: Request | undefined;
  let calls = 0;
  const upload = createMultipartUpload(config, { timeoutMs: 1000, fetch: async (input) => {
    calls++;
    sent = input as Request;
    return new Response(null, { status: 200, headers: { etag: '"a&b"' } });
  } });
  assert.deepEqual(await upload('folder/a +%/é', 'id+/=%', 7, new Uint8Array([1, 2])), { partNumber: 7, etag: '"a&b"', size: 2 });
  const url = new URL(sent!.url);
  assert.equal(url.pathname, '/test-bucket/folder/a%20%2B%25/%C3%A9');
  assert.equal(url.searchParams.get('uploadId'), 'id+/=%');
  assert.equal(url.searchParams.get('partNumber'), '7');
  assert.equal(sent!.method, 'PUT');
  assert.match(sent!.headers.get('authorization') ?? '', /AWS4-HMAC-SHA256/);
  assert.deepEqual(new Uint8Array(await sent!.arrayBuffer()), new Uint8Array([1, 2]));
  assert.equal(calls, 1);
});

test('reports the sent size if the caller detaches the input during upload', async () => {
  const body = new Uint8Array([1, 2, 3]);
  const upload = createMultipartUpload(config, { timeoutMs: 1000, fetch: async (input) => {
    structuredClone(body.buffer, { transfer: [body.buffer] });
    assert.deepEqual(new Uint8Array(await (input as Request).arrayBuffer()), new Uint8Array([1, 2, 3]));
    return new Response(null, { status: 200, headers: { etag: '"part"' } });
  } });
  assert.deepEqual(await upload('key', 'id', 1, body), { partNumber: 1, etag: '"part"', size: 3 });
  assert.equal(body.byteLength, 0);
});

test('snapshots the measured length when shared input grows', async () => {
  const buffer = new SharedArrayBuffer(3, { maxByteLength: 6 });
  class GrowingBytes extends Uint8Array {
    override get byteLength() {
      const length = super.byteLength;
      buffer.grow(6);
      return length;
    }
  }
  const body = new GrowingBytes(buffer as unknown as ArrayBuffer);
  body.set([1, 2, 3]);
  const upload = createMultipartUpload(config, { timeoutMs: 1000, fetch: async (input) => {
    assert.deepEqual(new Uint8Array(await (input as Request).arrayBuffer()), new Uint8Array([1, 2, 3]));
    return new Response(null, { status: 200, headers: { etag: '"part"' } });
  } });
  assert.deepEqual(await upload('key', 'id', 1, body), { partNumber: 1, etag: '"part"', size: 3 });
});

test('rejects invalid input before sending and reports uncertain results without retries', async () => {
  let calls = 0;
  let response: () => Promise<Response> = async () => new Response(null, { status: 200 });
  const upload = createMultipartUpload(config, { timeoutMs: 1000, fetch: async () => { calls++; return response(); } });
  for (const number of [0, 10001, 1.5]) await assert.rejects(upload('key', 'id', number, new Uint8Array()), /Invalid multipart/);
  await assert.rejects(upload('a/../b', 'id', 1, new Uint8Array()), /Invalid S3 object key/);
  await assert.rejects(upload('key', 'id', 1, new Uint8Array(16 * 1024 * 1024 + 1)), /part limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(upload('key', 'id', 1, new Uint8Array(), controller.signal), /cancelled/);
  assert.equal(calls, 0);
  await assert.rejects(upload('key', 'id', 1, new Uint8Array()), /outcome uncertain/);
  response = async () => new Response(null, { status: 503 });
  await assert.rejects(upload('key', 'id', 1, new Uint8Array()), /outcome uncertain/);
  response = async () => { throw new Error('secret provider detail'); };
  await assert.rejects(upload('key', 'id', 1, new Uint8Array()), { message: 'S3 part upload outcome uncertain' });
  response = async () => new Response(null, { status: 403 });
  await assert.rejects(upload('key', 'id', 1, new Uint8Array()), { message: 'S3 request failed with status 403' });
  assert.equal(calls, 4);
});
