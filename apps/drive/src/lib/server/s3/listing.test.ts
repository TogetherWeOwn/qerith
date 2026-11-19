import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createS3Listing } from './listing';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };
const page = (content: string) => `<ListBucketResult><EncodingType>url</EncodingType>${content}</ListBucketResult>`;

test('lists an encoded page with opaque keys and continuation token', async () => {
  let sent: Request | undefined;
  let calls = 0;
  const listing = createS3Listing(config, { timeoutMs: 1000, fetch: async (input) => {
    calls++; sent = input as Request;
    return new Response(page('<Contents><Key>a%2F..%2F%00%2B%25%E9%9B%AA</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next+/=&amp;</NextContinuationToken>'));
  } });
  assert.deepEqual(await listing.objects({ prefix: 'a +%', continuationToken: 'old+/=' }), {
    keys: ['a/../\0+%雪'], nextContinuationToken: 'next+/=&'
  });
  const url = new URL(sent!.url);
  assert.equal(url.pathname, '/test-bucket/');
  assert.equal(url.searchParams.get('prefix'), 'a +%');
  assert.equal(url.searchParams.get('continuation-token'), 'old+/=');
  assert.equal(url.searchParams.get('encoding-type'), 'url');
  assert.equal(url.searchParams.get('list-type'), '2');
  assert.match(sent!.headers.get('authorization') ?? '', /AWS4-HMAC-SHA256/);
  assert.equal(calls, 1);
});

test('decodes spaces and literal pluses in listed keys without changing cursors', async () => {
  const listing = createS3Listing(config, { timeoutMs: 1000, fetch: async () => new Response(page(
    '<Contents><Key>a+b%2Bc%20d</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next+%2B</NextContinuationToken>'
  )) });
  assert.deepEqual(await listing.objects(), { keys: ['a b+c d'], nextContinuationToken: 'next+%2B' });
});

test('rejects ambiguous, invalid or non-advancing pages', async () => {
  for (const body of [
    page('<IsTruncated>true</IsTruncated>'),
    page('<IsTruncated>true</IsTruncated><NextContinuationToken>old</NextContinuationToken>'),
    page('<IsTruncated>false</IsTruncated><NextContinuationToken>extra</NextContinuationToken>'),
    page('<IsTruncated>yes</IsTruncated>'),
    page('<IsTruncated>false</IsTruncated><IsTruncated>false</IsTruncated>'),
    page('<IsTruncated>false</IsTruncated><Contents><Key>%FF</Key></Contents>'),
    page('<IsTruncated>false</IsTruncated><Contents><Key/></Contents>'),
    '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'
  ]) {
    const listing = createS3Listing(config, { timeoutMs: 1000, fetch: async () => new Response(body) });
    await assert.rejects(listing.objects({ continuationToken: 'old' }), { message: 'Invalid S3 listing response' });
  }
});

test('lists parts and validates pagination and part metadata', async () => {
  let sent: Request | undefined;
  const wrap = (content: string) => `<ListPartsResult><Bucket>test-bucket</Bucket><Key>key</Key><UploadId>upload+/=</UploadId>${content}</ListPartsResult>`;
  const listing = createS3Listing(config, { timeoutMs: 1000, fetch: async (input) => {
    sent = input as Request;
    return new Response(wrap('<IsTruncated>true</IsTruncated><PartNumberMarker>1</PartNumberMarker><NextPartNumberMarker>2</NextPartNumberMarker><Part><PartNumber>2</PartNumber><Size>42</Size><ETag>"tag"</ETag></Part>'));
  } });
  assert.deepEqual(await listing.parts('key', 'upload+/=', { partNumberMarker: 1 }), {
    parts: [{ partNumber: 2, size: 42, etag: '"tag"' }], nextPartNumberMarker: 2
  });
  const url = new URL(sent!.url);
  assert.equal(url.searchParams.get('uploadId'), 'upload+/=');
  assert.equal(url.searchParams.get('part-number-marker'), '1');
  const final = createS3Listing(config, { timeoutMs: 1000, fetch: async () => new Response(wrap('<IsTruncated>false</IsTruncated><NextPartNumberMarker>0</NextPartNumberMarker>')) });
  assert.deepEqual(await final.parts('key', 'upload+/='), { parts: [], nextPartNumberMarker: undefined });
  for (const content of [
    '<IsTruncated>true</IsTruncated>',
    '<IsTruncated>false</IsTruncated><PartNumberMarker>0</PartNumberMarker>',
    '<IsTruncated>false</IsTruncated><PartNumberMarker>1</PartNumberMarker><PartNumberMarker>1</PartNumberMarker>',
    '<IsTruncated>false</IsTruncated><PartNumberMarker>1e0</PartNumberMarker>',
    '<IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker>',
    '<IsTruncated>false</IsTruncated><Part><PartNumber>2</PartNumber><Size>-1</Size><ETag>x</ETag></Part>',
    '<IsTruncated>false</IsTruncated><Part><PartNumber>2</PartNumber><Size>1</Size><ETag>x</ETag></Part><Part><PartNumber>2</PartNumber><Size>1</Size><ETag>x</ETag></Part>'
  ]) {
    const bad = createS3Listing(config, { timeoutMs: 1000, fetch: async () => new Response(wrap(content)) });
    await assert.rejects(bad.parts('key', 'upload+/=', { partNumberMarker: 1 }), { message: 'Invalid S3 listing response' });
  }
});

test('requires one exact bucket, key and upload ID in each ListParts result', async () => {
  const identity = ['<Bucket>test-bucket</Bucket>', '<Key>key</Key>', '<UploadId>id</UploadId>'];
  for (const [index, field] of identity.entries()) {
    for (const replacement of ['', field + field, field.replace(/>([^<]+)</, '>other<')]) {
      const fields = identity.with(index, replacement).join('');
      const listing = createS3Listing(config, { timeoutMs: 1000, fetch: async () => new Response(
        `<ListPartsResult>${fields}<IsTruncated>false</IsTruncated></ListPartsResult>`
      ) });
      await assert.rejects(listing.parts('key', 'id'), { message: 'Invalid S3 listing response' });
    }
  }
});

test('lists multipart uploads with opaque paired cursors', async () => {
  let sent: Request | undefined;
  const wrap = (content: string) => `<ListMultipartUploadsResult><EncodingType>url</EncodingType>${content}</ListMultipartUploadsResult>`;
  const listing = createS3Listing(config, { timeoutMs: 1000, fetch: async (input) => {
    sent = input as Request;
    return new Response(wrap('<IsTruncated>true</IsTruncated><NextKeyMarker>a+b%2B%2F%25</NextKeyMarker><NextUploadIdMarker>next+/=</NextUploadIdMarker><Upload><Key>a+b%2B%2F%25</Key><UploadId>next+/=</UploadId></Upload>'));
  } });
  assert.deepEqual(await listing.uploads({ keyMarker: 'old +', uploadIdMarker: 'old/id' }), {
    uploads: [{ key: 'a b+/%', uploadId: 'next+/=' }], nextKeyMarker: 'a b+/%', nextUploadIdMarker: 'next+/='
  });
  const url = new URL(sent!.url);
  assert.equal(url.searchParams.get('key-marker'), 'old +');
  assert.equal(url.searchParams.get('upload-id-marker'), 'old/id');
  for (const content of [
    '<IsTruncated>true</IsTruncated><NextKeyMarker>old%20%2B</NextKeyMarker><NextUploadIdMarker>old/id</NextUploadIdMarker>',
    '<IsTruncated>true</IsTruncated><NextKeyMarker>next</NextKeyMarker>',
    '<IsTruncated>false</IsTruncated><Upload><Key>%FF</Key><UploadId>x</UploadId></Upload>'
  ]) {
    const bad = createS3Listing(config, { timeoutMs: 1000, fetch: async () => new Response(wrap(content)) });
    await assert.rejects(bad.uploads({ keyMarker: 'old +', uploadIdMarker: 'old/id' }), { message: 'Invalid S3 listing response' });
  }
  await listing.uploads({ keyMarker: 'only' });
  assert.equal(new URL(sent!.url).searchParams.get('key-marker'), 'only');
  await assert.rejects(listing.uploads({ uploadIdMarker: 'only' }), { message: 'Invalid S3 listing cursor' });
  const final = createS3Listing(config, { timeoutMs: 1000, fetch: async (input) => {
    sent = input as Request;
    return new Response(wrap('<IsTruncated>false</IsTruncated><NextKeyMarker/><NextUploadIdMarker/><Upload><Key>a%2F..%2Fb</Key><UploadId>../%2F</UploadId></Upload>'));
  } });
  assert.deepEqual(await final.uploads({ prefix: '../%2F', keyMarker: '../%2E', uploadIdMarker: '../%2F' }), {
    uploads: [{ key: 'a/../b', uploadId: '../%2F' }], nextKeyMarker: undefined, nextUploadIdMarker: undefined
  });
  const finalUrl = new URL(sent!.url);
  assert.equal(finalUrl.searchParams.get('prefix'), '../%2F');
  assert.equal(finalUrl.searchParams.get('key-marker'), '../%2E');
  assert.equal(finalUrl.searchParams.get('upload-id-marker'), '../%2F');
});

test('rejects unsupported addressed keys before transport', async () => {
  let calls = 0;
  const listing = createS3Listing(config, { timeoutMs: 1000, fetch: async () => { calls++; return new Response(); } });
  for (const key of ['', '.', '..', './x', 'x/.', 'x/../y', '\ud800']) {
    await assert.rejects(listing.parts(key, 'id'), { message: 'Invalid or unsupported S3 key' });
  }
  assert.equal(calls, 0);
});

test('round-trips supported listed keys and opaque query data', async () => {
  const requests: Request[] = [];
  const listing = createS3Listing(config, { timeoutMs: 1000, fetch: async (input) => {
    const request = input as Request; requests.push(request);
    if (requests.length === 1) return new Response(page('<IsTruncated>false</IsTruncated><Contents><Key>safe%2F...%2Fa..b%2F%252E%252F%2B%20%E9%9B%AA</Key></Contents>'));
    return new Response('<ListPartsResult><Bucket>test-bucket</Bucket><Key>safe/.../a..b/%2E%2F+ 雪</Key><UploadId>../%2F+</UploadId><IsTruncated>false</IsTruncated></ListPartsResult>');
  } });
  const result = await listing.objects({ prefix: '../%2F', continuationToken: '../%2E/' });
  assert.deepEqual(result.keys, ['safe/.../a..b/%2E%2F+ 雪']);
  await listing.parts(result.keys[0], '../%2F+');
  assert.equal(requests[1].url, 'https://storage.example/test-bucket/safe/.../a..b/%252E%252F%2B%20%E9%9B%AA?uploadId=..%2F%252F%2B');
  assert.equal(new URL(requests[0].url).searchParams.get('prefix'), '../%2F');
  assert.equal(new URL(requests[0].url).searchParams.get('continuation-token'), '../%2E/');
});

test('reports errors without provider details and honors cancellation', async () => {
  let calls = 0;
  const listing = createS3Listing(config, { timeoutMs: 1000, fetch: async () => { calls++; throw new Error('secret'); } });
  await assert.rejects(listing.objects(), { message: 'S3 request failed' });
  await assert.rejects(listing.objects({ continuationToken: '' }), { message: 'Invalid S3 listing cursor' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listing.objects({ signal: controller.signal }), { message: 'S3 request cancelled' });
  assert.equal(calls, 1);
  const empty = createS3Listing(config, { timeoutMs: 1000, fetch: async () => new Response(page('<IsTruncated>false</IsTruncated>')) });
  assert.deepEqual(await empty.objects(), { keys: [], nextContinuationToken: undefined });
});
