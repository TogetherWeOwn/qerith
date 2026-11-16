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
