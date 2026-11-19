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
  assert.equal(sent!.headers.get('if-none-match'), '*');
  assert.match(sent!.headers.get('authorization') ?? '', /signedheaders=[^,]*if-none-match/i);
  assert.match(sent!.headers.get('authorization') ?? '', /AWS4-HMAC-SHA256/);
  assert.match(await sent!.text(), /<PartNumber>1<\/PartNumber><ETag>"a&amp;b"<\/ETag>/);
  assert.equal(calls, 1);
});

test('rejects contradictory completion identity without retrying', async () => {
  let calls = 0;
  let identity = '<Bucket>other</Bucket><Key>key</Key>';
  const complete = createMultipartComplete(config, { timeoutMs: 1000, fetch: async () => {
    calls++;
    return new Response(`<CompleteMultipartUploadResult><ETag>"result"</ETag>${identity}</CompleteMultipartUploadResult>`);
  } });
  await assert.rejects(complete('key', 'id', parts), /outcome uncertain/);
  identity = '<Bucket>test-bucket</Bucket><Key>other</Key>';
  await assert.rejects(complete('key', 'id', parts), /outcome uncertain/);
  identity = '<Bucket>test-bucket</Bucket><Key>key</Key>';
  assert.equal((await complete('key', 'id', parts)).etag, '"result"');
  assert.equal(calls, 3);
});

test('binds completion identity to the configured request bucket despite mutation', async () => {
  const mutableConfig = { ...config };
  let calls = 0;
  let bucket = 'test-bucket';
  const complete = createMultipartComplete(mutableConfig, { timeoutMs: 1000, fetch: async (input) => {
    calls++;
    assert.equal(new URL((input as Request).url).pathname, '/test-bucket/key');
    mutableConfig.bucket = 'other';
    return new Response(`<CompleteMultipartUploadResult><ETag>"result"</ETag><Bucket>${bucket}</Bucket><Key>key</Key></CompleteMultipartUploadResult>`);
  } });
  assert.equal((await complete('key', 'id', parts)).etag, '"result"');
  bucket = 'other';
  await assert.rejects(complete('key', 'id', parts), /outcome uncertain/);
  assert.equal(calls, 2);
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

for (const code of ['InternalError', 'ServiceUnavailable', 'SlowDown', 'RequestTimeout', 'OperationAborted', 'UnknownProviderError']) {
  test(`embedded ${code} preserves uncertainty without retrying or leaking details`, async () => {
    let calls = 0;
    const complete = createMultipartComplete(config, { timeoutMs: 1000, fetch: async () => {
      calls++;
      return new Response(`<Error><Code>${code}</Code><Message>secret</Message><RequestId>private</RequestId></Error>`);
    } });
    await assert.rejects(complete('key', 'id', parts), { message: 'S3 multipart completion outcome uncertain' });
    assert.equal(calls, 1);
  });
}

for (const code of ['EntityTooSmall', 'InvalidPart', 'InvalidPartOrder', 'NoSuchUpload']) {
  test(`embedded ${code} is an explicit rejection without retrying or leaking details`, async () => {
    let calls = 0;
    const complete = createMultipartComplete(config, { timeoutMs: 1000, fetch: async () => {
      calls++;
      return new Response(`<Error><Code>${code}</Code><Message>secret</Message></Error>`);
    } });
    await assert.rejects(complete('key', 'id', parts), { message: 'S3 multipart completion failed' });
    assert.equal(calls, 1);
  });
}

test('completion preserves 409 and 412 as distinct rejections without retries', async () => {
  let calls = 0;
  const complete = createMultipartComplete(config, { timeoutMs: 1000, fetch: async () => {
    calls++;
    return new Response(null, { status: calls === 1 ? 412 : 409 });
  } });
  await assert.rejects(complete('key', 'id', parts), /status 412/);
  await assert.rejects(complete('key', 'id', parts), /status 409/);
  assert.equal(calls, 2);
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
