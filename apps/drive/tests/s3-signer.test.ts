import assert from 'node:assert/strict';
import test from 'node:test';
import { AwsClient } from 'aws4fetch';
import { createS3Signer } from '../src/lib/server/s3/signer';

// Published examples: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html
const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const options = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  now: () => new Date('2013-05-24T00:00:00Z')
};
const scope = 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request';

test('signs the published ranged GET and sends it through the injected fetch', async () => {
  let sent: Request | undefined;
  const signer = createS3Signer({ ...options, fetch: async function (this: unknown, input) {
    assert.equal(this, undefined);
    sent = input as Request;
    return new Response('ok');
  } });
  const response = await signer.fetch('https://examplebucket.s3.amazonaws.com/test.txt', {
    headers: { range: 'bytes=0-9', 'x-amz-content-sha256': emptyHash }
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(sent?.headers.get('authorization'), `${scope}, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41`);
});

test('signs the published list query independently of query order', async () => {
  const signer = createS3Signer({ ...options, fetch });
  const request = await signer.sign('https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2', {
    headers: { 'x-amz-content-sha256': emptyHash }
  });
  assert.equal(request.headers.get('authorization'), `${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7`);
});

test('signs the actual normalized request and preserves fetch options', async () => {
  const signer = createS3Signer({ ...options, fetch });
  const request = await signer.sign('https://example.com/', {
    method: 'put', body: 'hello', credentials: 'omit',
    headers: { 'x-amz-content-sha256': '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }
  });
  assert.equal(request.method, 'PUT');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.headers.get('content-type'), 'text/plain;charset=UTF-8');
  assert.match(request.headers.get('authorization') ?? '', /SignedHeaders=content-type;host;/);
  assert.equal(await request.text(), 'hello');
  await assert.rejects(signer.sign('https://example.com/', {
    method: 'propfind', headers: { 'x-amz-content-sha256': emptyHash }
  }), /method/);
  await assert.rejects(signer.sign('https://example.com/', {
    method: 'PUT', body: new FormData(), headers: { 'x-amz-content-sha256': emptyHash }
  }), /body/);
  await assert.rejects(signer.sign('https://example.com/', {
    method: 'PUT', body: new ReadableStream(), headers: { 'x-amz-content-sha256': emptyHash }
  } as RequestInit), /body/);
  await assert.rejects(signer.sign('https://example.com/', {
    method: 'PUT', body: 'hello', keepalive: true,
    headers: { 'x-amz-content-sha256': emptyHash }
  }), /keepalive/);
});

test('signs with the original abort signal, not the normalization request signal', async (t) => {
  const sign = t.mock.method(AwsClient.prototype, 'sign');
  const signer = createS3Signer({ ...options, fetch });
  const controller = new AbortController();
  const request = await signer.sign('https://example.invalid/', {
    headers: { 'x-amz-content-sha256': emptyHash }, signal: controller.signal
  });
  assert.equal(sign.mock.calls[0]?.arguments[1]?.signal, controller.signal);
  controller.abort();
  assert.equal(request.signal.reason, controller.signal.reason);
});

test('snapshots mutable bodies before asynchronous signing', async () => {
  const signer = createS3Signer({ ...options, fetch });
  const bytes = new Uint8Array([1, 2]);
  const parameters = new URLSearchParams('a=1');
  const first = signer.sign('https://example.com/', {
    method: 'PUT', body: bytes, headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }
  });
  const second = signer.sign('https://example.com/', {
    method: 'PUT', body: parameters, headers: { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }
  });
  bytes[0] = 9;
  parameters.set('a', '2');
  assert.deepEqual(new Uint8Array(await (await first).arrayBuffer()), new Uint8Array([1, 2]));
  assert.equal(await (await second).text(), 'a=1');
});

test('fails closed for query parameters the signer cannot canonicalize', async () => {
  const signer = createS3Signer({ ...options, fetch });
  const init = { headers: { 'x-amz-content-sha256': emptyHash } };
  await assert.rejects(signer.sign('https://example.com/?a=1&a=2', init), /query/);
  await assert.rejects(signer.sign('https://example.com/?a=1&&b=2', init), /query/);
  await assert.rejects(signer.sign('https://example.com/?=value', init), /query/);
  await assert.rejects(signer.sign('https://example.com/a+b', init), /URL/);
  await assert.rejects(signer.sign('https://example.com/a%2Fb', init), /URL/);
  await assert.rejects(signer.sign('https://user:password@example.com/', init), /URL/);
  await assert.rejects(signer.sign('https://example.com/', { headers: { authorization: 'stale' } }), /headers/);
  await assert.rejects(signer.sign('https://example.com/', { headers: { 'user-agent': 'unstable' } }), /headers/);
  await assert.rejects(signer.sign('http://example.com/', init), /URL/);
  await assert.rejects(signer.sign('https://example.com/a/%2e%2e/b', init), /URL/);
  await assert.rejects(signer.sign('https://example.com/a/..\\b', init), /URL/);
  await assert.rejects(signer.sign(' https://example.com/a/../b', init), /URL/);
  await assert.rejects(signer.sign('https://example.com/?prefix=a+b', init), /query/);
  await assert.rejects(signer.sign('https://example.com/'), /payload hash/);
  await assert.rejects(signer.sign('https://example.com/', { headers: { 'x-amz-content-sha256': '' } }), /payload hash/);
  await assert.rejects(signer.sign('https://example.com/?prefix=archive/../', init), /query/);
  await assert.rejects(signer.sign('https://example.com/%7Efile', init), /encoding/);
  await assert.rejects(signer.sign('https://example.com/%FF', init), /encoding/);
  await assert.rejects(signer.sign('https://example.com/?prefix=%GG', init), /encoding/);
  const query = await signer.sign('https://example.com/?prefix=archive%2F..%2F', init);
  assert.equal(new URL(query.url).searchParams.get('prefix'), 'archive/../');
  const injected = await signer.sign('https://example.com/', { ...init, url: 'http://example.com/' } as RequestInit);
  assert.equal(injected.url, 'https://example.com/');
});
