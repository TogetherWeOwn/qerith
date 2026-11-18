import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createCompleteForPublication } from './complete-for-publication';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };
const parts = [{ partNumber: 1, etag: '"part"', size: 7 }];
const completed = '<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>';

test('reads provider size with a conditional HEAD after create-only completion', async () => {
  const calls: Request[] = [];
  const complete = createCompleteForPublication(config, { timeoutMs: 1000, fetch: async input => {
    const request = input as Request;
    calls.push(request);
    return request.method === 'POST' ? new Response(completed) :
      new Response(null, { headers: { etag: '"complete"', 'content-length': '7' } });
  } });
  assert.deepEqual(await complete('key', 'upload', parts), { etag: '"complete"', size: 7 });
  assert.deepEqual(calls.map(call => call.method), ['POST', 'HEAD']);
  assert.equal(calls[0].headers.get('if-none-match'), '*');
  assert.equal(calls[1].headers.get('if-match'), '"complete"');
  assert.equal(new URL(calls[1].url).pathname, new URL(calls[0].url).pathname);
});

test('refuses missing, invalid, or mismatched HEAD evidence without retrying', async () => {
  const responses = [
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 412 }),
    () => new Response(null, { headers: { etag: '"other"', 'content-length': '7' } }),
    () => new Response(null, { headers: { etag: '"complete"' } }),
    () => new Response(null, { headers: { etag: '"complete"', 'content-length': '9007199254740992' } }),
    () => { throw new Error('provider unavailable'); },
  ];
  for (const response of responses) {
    let calls = 0;
    const complete = createCompleteForPublication(config, { timeoutMs: 1000, fetch: async input => {
      calls++;
      return (input as Request).method === 'POST' ? new Response(completed) : response();
    } });
    await assert.rejects(complete('key', 'upload', parts));
    assert.equal(calls, 2);
  }
});
