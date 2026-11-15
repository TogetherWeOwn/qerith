import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createMultipartComplete } from './multipart-complete';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };
const parts = [{ partNumber: 1, etag: '"a&b"', size: 1 }];

test('completes once with ordered opaque parts and a signed request', async () => {
  let sent: Request | undefined;
  let calls = 0;
  const complete = createMultipartComplete(config, { timeoutMs: 1000, fetch: async (input) => {
    calls++; sent = input as Request;
    return new Response('<CompleteMultipartUploadResult><ETag>"result"</ETag></CompleteMultipartUploadResult>');
  } });
  assert.equal((await complete('folder/a +%/é', 'id+/=%', parts)).etag, '"result"');
  const url = new URL(sent!.url);
  assert.equal(url.pathname, '/test-bucket/folder/a%20%2B%25/%C3%A9');
  assert.equal(url.searchParams.get('uploadId'), 'id+/=%');
  assert.equal(sent!.method, 'POST');
  assert.match(sent!.headers.get('authorization') ?? '', /AWS4-HMAC-SHA256/);
  assert.match(await sent!.text(), /<PartNumber>1<\/PartNumber><ETag>"a&amp;b"<\/ETag>/);
  assert.equal(calls, 1);
});

test('distinguishes embedded errors from uncertain outcomes without leaking provider details', async () => {
  let calls = 0;
  let response: () => Promise<Response> = async () => new Response('<Error><Code>InvalidPart</Code><Message>secret</Message></Error>');
  const complete = createMultipartComplete(config, { timeoutMs: 1000, fetch: async () => { calls++; return response(); } });
  await assert.rejects(complete('key', 'id', parts), { message: 'S3 multipart completion failed' });
  response = async () => new Response('not xml');
  await assert.rejects(complete('key', 'id', parts), /outcome uncertain/);
  response = async () => new Response(null, { status: 503 });
  await assert.rejects(complete('key', 'id', parts), /outcome uncertain/);
  response = async () => { throw new Error('secret'); };
  await assert.rejects(complete('key', 'id', parts), { message: 'S3 multipart completion outcome uncertain' });
  response = async () => new Response(null, { status: 403 });
  await assert.rejects(complete('key', 'id', parts), { message: 'S3 request failed with status 403' });
  assert.equal(calls, 5);
});

test('rejects invalid inputs and pre-cancellation without sending', async () => {
  let calls = 0;
  const complete = createMultipartComplete(config, { timeoutMs: 1000, fetch: async () => { calls++; return new Response(); } });
  await assert.rejects(complete('a/../b', 'id', parts), /Invalid S3 object key/);
  await assert.rejects(complete('key', '', parts), /Invalid multipart upload/);
  await assert.rejects(complete('key', 'id', []), /part count/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(complete('key', 'id', parts, controller.signal), /cancelled/);
  assert.equal(calls, 0);
});
