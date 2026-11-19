import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadFile } from '../src/lib/server/download';
import { createImmutableS3Reader, createS3Objects } from '../src/lib/server/s3/objects';

const fileId = 'opaque-file';
const generation = { name: 'résumé; "a".txt', key: 'private-key', etag: '"stored"', sizeBytes: 4,
  storageConfigId: 'config-a', evidenceRevision: 'receipt-a' };
const request = (headers?: HeadersInit) => new Request('https://example.test/api/download/opaque-file', { headers });

function setup(reply: () => Response) {
  const reads: Request[] = [];
  const reader = createImmutableS3Reader(createS3Objects({
    endpoint: 'https://storage.example', bucket: 'private-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret'
  }, { timeoutMs: 1000, fetch: async (input) => { reads.push(new Request(input)); return reply(); } }));
  return {
    reads, authorize: async () => fileId, resolveGeneration: async () => generation,
    readerFor: (id: string) => id === generation.storageConfigId ? reader : null
  };
}

test('checks live authorization on each request before resolving generation', async () => {
  const deps = setup(() => new Response('data', { headers: { etag: generation.etag, 'content-length': '4' } }));
  let authorized = true;
  let resolutions = 0;
  const sameRequest = request();
  const outside = request({ range: 'bytes=9223372036854775807-' });
  const handle = (input: Request) => downloadFile(input, fileId, {
    ...deps, authorize: async () => authorized ? fileId : null,
    resolveGeneration: async (access, id) => { assert.equal(access, id); resolutions++; return generation; }
  });
  assert.equal((await downloadFile(sameRequest, fileId)).status, 503);
  assert.equal(await (await handle(sameRequest)).text(), 'data');
  const unsatisfied = await handle(outside);
  assert.equal(unsatisfied.status, 416);
  assert.equal(unsatisfied.headers.get('content-range'), 'bytes */4');
  authorized = false;
  for (const input of [sameRequest, outside]) {
    const denied = await handle(input);
    assert.equal(denied.status, 404);
    assert.equal(denied.headers.get('content-range'), null);
    assert.equal(denied.body, null);
  }
  assert.equal(resolutions, 2);
  assert.equal(deps.reads.length, 1);
});

test('streams full and single-range responses with the stored validator and allowlisted headers', async () => {
  for (const range of [null, 'bytes=-2', 'bytes=2-9223372036854775807']) {
    let pulls = 0;
    const ranged = range !== null;
    const length = ranged ? '2' : '4';
    const deps = setup(() => new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(ranged ? 'ta' : 'data'));
      else controller.close();
    } }, { highWaterMark: 0 }), { status: ranged ? 206 : 200, headers: {
      etag: generation.etag, 'x-storage-key': generation.key,
      ...(ranged ? { 'content-range': 'Bytes 02-03/04' } : { 'content-length': length })
    } }));
    const response = await downloadFile(request(range === null ? { 'if-match': '*' } : {
      range, 'if-range': generation.etag, 'if-match': `W/"old", "tag,with,commas", ${generation.etag}`
    }), fileId, deps);
    assert.equal(response.status, ranged ? 206 : 200);
    assert.equal(response.headers.get('content-range'), ranged ? 'bytes 2-3/4' : null);
    assert.equal(response.headers.get('content-length'), length);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="rsum; a.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%3B%20%22a%22.txt`);
    assert.equal(response.headers.get('x-storage-key'), null);
    assert.equal(pulls, 0);
    assert.equal(await response.text(), ranged ? 'ta' : 'data');
    assert.equal(deps.reads.length, 1);
    assert.equal(deps.reads[0].headers.get('if-match'), generation.etag);
    assert.equal(deps.reads[0].headers.get('range'), ranged ? 'bytes=2-3' : null);
    assert.equal(deps.reads[0].headers.get('if-range'), null);
  }
});

test('does not read without trusted evidence or downgrade a conditional range', async () => {
  const deps = setup(() => new Response());
  for (const value of [null, { ...generation, etag: 'W/"weak"' }, { ...generation, storageConfigId: 'unknown' }]) {
    assert.equal((await downloadFile(request(), fileId, { ...deps, resolveGeneration: async () => value })).status, 404);
  }
  for (const ifMatch of ['"stale"', `W/${generation.etag}`, `${generation.etag}, invalid`]) {
    assert.equal((await downloadFile(request({ 'if-match': ifMatch }), fileId, deps)).status, 412);
  }
  assert.equal((await downloadFile(request({ range: 'bytes=1-', 'if-range': '"stale"' }), fileId, deps)).status, 412);
  assert.equal((await downloadFile(request({ range: 'bytes=-0' }), fileId, deps)).status, 416);
  assert.equal((await downloadFile(request({ range: 'bytes=0-0,2-3' }), fileId, deps)).status, 400);
  assert.equal(deps.reads.length, 0);
});

test('checks strong If-Match before weak If-None-Match and evaluates both before Range', async () => {
  let reply = () => new Response(null, { headers: { etag: generation.etag, 'content-length': '4' } });
  const deps = setup(() => reply());
  const headers = { 'if-none-match': `"tag,with,commas", W/${generation.etag}`, range: 'bytes=20-' };
  const fresh = await downloadFile(request(headers), fileId, deps);
  assert.equal(fresh.status, 304);
  assert.equal(fresh.headers.get('etag'), generation.etag);
  assert.equal(fresh.headers.get('content-range'), null);
  assert.equal(fresh.headers.get('content-disposition'), null);
  assert.equal(fresh.body, null);
  assert.equal((await downloadFile(request({ ...headers, 'if-match': '"stale"' }), fileId, deps)).status, 412);
  for (const response of [await downloadFile(request(headers), fileId, { ...deps, authorize: async () => null }),
    await downloadFile(request(headers), fileId, { ...deps, readerFor: () => null })]) {
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('etag'), null);
  }
  assert.deepEqual(deps.reads.map((read) => [read.method, read.headers.get('if-match'), read.headers.get('range')]),
    [['HEAD', generation.etag, null]]);
  for (const [status, length] of [[404, '4'], [412, '4'], [200, '5']] as const) {
    reply = () => new Response(null, { status, headers: { etag: generation.etag, 'content-length': length } });
    const missing = await downloadFile(request(headers), fileId, deps);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('etag'), null);
  }
});

test('suppresses upstream failures and contradictory evidence without retrying', async () => {
  const cases: [number, HeadersInit, string?][] = [
    [412, {}, 'bytes=1-2'], [416, { 'content-range': 'bytes */9' }, 'bytes=1-2'],
    [200, { etag: generation.etag, 'content-length': '4' }, 'bytes=1-2'],
    [200, { etag: generation.etag, 'content-length': '9' }],
    [206, { etag: '"other"', 'content-range': 'bytes 1-2/4' }, 'bytes=1-2'],
    [206, { etag: generation.etag, 'content-range': 'bytes 1-2/9' }, 'bytes=1-2']
  ];
  for (const [status, headers, range] of cases) {
    const deps = setup(() => new Response(generation.key, { status, headers }));
    const response = await downloadFile(request(range ? { range } : undefined), fileId, deps);
    assert.equal(response.status, 404);
    assert.equal(response.body, null);
    assert.equal(response.headers.get('content-range'), null);
    assert.equal(deps.reads.length, 1);
  }
});
