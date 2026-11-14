import assert from 'node:assert/strict';
import test from 'node:test';
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
  const signer = createS3Signer({ ...options, fetch: async (input) => {
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

test('fails closed for query parameters the signer cannot canonicalize', async () => {
  const signer = createS3Signer({ ...options, fetch });
  const init = { headers: { 'x-amz-content-sha256': emptyHash } };
  await assert.rejects(signer.sign('https://example.com/?a=1&a=2', init), /query/);
  await assert.rejects(signer.sign('https://example.com/?=value', init), /query/);
  await assert.rejects(signer.sign('https://example.com/a+b'));
  await assert.rejects(signer.sign('https://example.com/a%2Fb'));
  await assert.rejects(signer.sign('https://user:password@example.com/'));
  await assert.rejects(signer.sign('https://example.com/', { headers: { authorization: 'stale' } }), /headers/);
  await assert.rejects(signer.sign('https://example.com/', { headers: { 'user-agent': 'unstable' } }), /headers/);
  await assert.rejects(signer.sign('http://example.com/', init), /URL/);
  await assert.rejects(signer.sign('https://example.com/a/%2e%2e/b', init), /URL/);
  await assert.rejects(signer.sign('https://example.com/'), /payload hash/);
});
