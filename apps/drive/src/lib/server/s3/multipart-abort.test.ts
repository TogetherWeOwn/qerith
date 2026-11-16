import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createMultipartAbort } from './multipart-abort';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };

test('aborts once with a signed request and opaque key and upload id', async () => {
  let sent: Request | undefined;
  let calls = 0;
  const abort = createMultipartAbort(config, { timeoutMs: 1000, fetch: async (input) => {
    calls++; sent = input as Request;
    return new Response(null, { status: 204 });
  } });
  await abort('folder/a +%/é', 'id+/=%');
  const url = new URL(sent!.url);
  assert.equal(url.pathname, '/test-bucket/folder/a%20%2B%25/%C3%A9');
  assert.equal(url.searchParams.get('uploadId'), 'id+/=%');
  assert.equal(sent!.method, 'DELETE');
  assert.match(sent!.headers.get('authorization') ?? '', /AWS4-HMAC-SHA256/);
  assert.equal(calls, 1);
});

test('reports ambiguous outcomes without retries or provider details', async () => {
  let calls = 0;
  let response: () => Promise<Response> = async () => new Response(null, { status: 503 });
  const abort = createMultipartAbort(config, { timeoutMs: 1000, fetch: async () => { calls++; return response(); } });
  await assert.rejects(abort('key', 'id'), { message: 'S3 multipart abort outcome uncertain' });
  response = async () => new Response(null, { status: 200 });
  await assert.rejects(abort('key', 'id'), /outcome uncertain/);
  response = async () => { throw new Error('secret'); };
  await assert.rejects(abort('key', 'id'), { message: 'S3 multipart abort outcome uncertain' });
  response = async () => new Response('secret', { status: 403 });
  await assert.rejects(abort('key', 'id'), { message: 'S3 request failed with status 403' });
  assert.equal(calls, 4);
});

test('rejects invalid inputs and pre-cancellation without sending', async () => {
  let calls = 0;
  const abort = createMultipartAbort(config, { timeoutMs: 1000, fetch: async () => { calls++; return new Response(); } });
  await assert.rejects(abort('a/../b', 'id'), /Invalid S3 object key/);
  await assert.rejects(abort('key', ''), /Invalid multipart upload/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(abort('key', 'id', controller.signal), /cancelled/);
  assert.equal(calls, 0);
});
