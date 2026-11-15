import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createMultipartCreate } from './multipart-create';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };

test('creates one signed upload and preserves opaque identifiers', async () => {
  let sent: Request | undefined;
  let calls = 0;
  const create = createMultipartCreate(config, { timeoutMs: 1000, fetch: async (input) => {
    calls++; sent = input as Request;
    return new Response('<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>test-bucket</Bucket><Key>key</Key><UploadId>id+/=%&amp;é</UploadId></InitiateMultipartUploadResult>');
  } });
  assert.deepEqual(await create('folder/a +%/é'), { uploadId: 'id+/=%&é' });
  const url = new URL(sent!.url);
  assert.equal(url.pathname, '/test-bucket/folder/a%20%2B%25/%C3%A9');
  assert.equal(url.search, '?uploads=');
  assert.equal(sent!.method, 'POST');
  assert.match(sent!.headers.get('authorization') ?? '', /AWS4-HMAC-SHA256/);
  assert.equal(await sent!.text(), '');
  assert.equal(calls, 1);
});

test('reports uncertain allocations without exposing provider details or retrying', async () => {
  let calls = 0;
  let response: () => Promise<Response> = async () => { throw new Error('secret'); };
  const create = createMultipartCreate(config, { timeoutMs: 1000, fetch: async () => { calls++; return response(); } });
  await assert.rejects(create('key'), { message: 'S3 multipart create allocation uncertain' });
  for (const status of [200, 201, 408, 500]) {
    response = async () => new Response('secret', { status });
    await assert.rejects(create('key'), { message: 'S3 multipart create allocation uncertain' });
  }
  response = async () => new Response('secret', { status: 403 });
  await assert.rejects(create('key'), { message: 'S3 request failed with status 403' });
  assert.equal(calls, 6);
});

test('rejects malformed, oversized and ambiguous response bodies', async () => {
  for (const xml of [
    '<InitiateMultipartUploadResult><UploadId/></InitiateMultipartUploadResult>',
    '<InitiateMultipartUploadResult><UploadId>a</UploadId><UploadId>b</UploadId></InitiateMultipartUploadResult>',
    '<!DOCTYPE x><InitiateMultipartUploadResult><UploadId>secret</UploadId></InitiateMultipartUploadResult>',
    '<InitiateMultipartUploadResult><UploadId>&unknown;</UploadId></InitiateMultipartUploadResult>',
    '<InitiateMultipartUploadResult><UploadId>secret</UploadId></InitiateMultipartUploadResult>trailing',
    'x'.repeat(65537)
  ]) {
    const create = createMultipartCreate(config, { timeoutMs: 1000, fetch: async () => new Response(xml) });
    await assert.rejects(create('key'), { message: 'S3 multipart create allocation uncertain' });
  }
});

test('validates inputs and cancellation before sending', async () => {
  let calls = 0;
  const create = createMultipartCreate(config, { timeoutMs: 1000, fetch: async () => { calls++; return new Response(); } });
  await assert.rejects(create('a/../b'), /Invalid S3 object key/);
  await assert.rejects(create('\ud800'), /Invalid S3 object key/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(create('key', controller.signal), /cancelled/);
  assert.equal(calls, 0);
});

test('cancellation during a request leaves allocation uncertain', async () => {
  const controller = new AbortController();
  const create = createMultipartCreate(config, { timeoutMs: 1000, fetch: async () => {
    controller.abort();
    throw new Error('private');
  } });
  await assert.rejects(create('key', controller.signal), { message: 'S3 multipart create allocation uncertain' });
});
