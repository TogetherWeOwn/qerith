import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createS3ObjectDeleter } from './private-object-deleter';

const config = { endpoint: 'https://storage.example/', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };
const epoch = 'epoch-1';
const id = JSON.stringify(['https://storage.example', config.bucket, epoch]);
const target = { key: 'folder/a +%/é!?#', etag: '"AbC+/%:-5"', sizeBytes: 3, evidenceRevision: '1' };
const confirmedHeaders = { 'x-fixture-result': 'removed' };
const confirmsRemoval = ({ headers }: { headers: Headers }) => headers.get('x-fixture-result') === 'removed';
const options = { timeoutMs: 1000, now: () => new Date('2026-01-02T03:04:05Z'), confirmsRemoval };

function bind(fetch: typeof globalThis.fetch, overrides: Partial<Parameters<typeof createS3ObjectDeleter>[2]> = {}) {
  return createS3ObjectDeleter(config, epoch, { ...options, fetch, ...overrides })(id)!;
}

test('resolves only the canonical fixed identity and signs one conditional DELETE', async () => {
  const settings = { ...config };
  const sent: Request[] = [];
  const resolve = createS3ObjectDeleter(settings, epoch, { ...options, fetch: async (input) => {
    sent.push(input as Request);
    return new Response(null, { status: 204, headers: confirmedHeaders });
  } });
  settings.endpoint = 'https://elsewhere.example';
  settings.bucket = 'other-bucket';
  for (const values of [[settings.endpoint, config.bucket, epoch], ['https://storage.example', settings.bucket, epoch],
    ['https://storage.example', config.bucket, 'epoch-2'], [config.endpoint, config.bucket, epoch]]) {
    assert.equal(resolve(JSON.stringify(values)), null);
  }
  assert.equal(resolve('unknown'), null);
  const deleter = resolve(id);
  assert.equal(deleter?.storageConfigId, id);
  assert.equal(await deleter?.deleteIfMatch(target, new AbortController().signal), 'deleted');
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.method, 'DELETE');
  assert.equal(request.url, 'https://storage.example/test-bucket/folder/a%20%2B%25/%C3%A9%21%3F%23');
  assert.equal(request.redirect, 'manual');
  assert.equal(request.body, null);
  assert.equal(request.headers.get('if-match'), target.etag);
  assert.equal(request.headers.get('x-amz-date'), '20260102T030405Z');
  assert.match(request.headers.get('authorization') ?? '', /^AWS4-HMAC-SHA256 Credential=access\/20260102\/us-east-1\/s3\/aws4_request, SignedHeaders=host;if-match;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/);
});

test('rejects invalid storage bindings and never dispatches invalid conditions or keys', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; return new Response(null, { status: 204 }); };
  assert.throws(() => createS3ObjectDeleter({ ...config, endpoint: 'http://localhost', allowLocalHttp: true }, epoch, { ...options, fetch }), /HTTPS/);
  assert.throws(() => createS3ObjectDeleter({ ...config, bucket: 'invalid/bucket' }, epoch, { ...options, fetch }), /configuration/);
  assert.throws(() => createS3ObjectDeleter(config, '', { ...options, fetch }), /epoch/);
  const deleter = bind(fetch);
  const signal = new AbortController().signal;
  for (const etag of ['*', 'W/"tag"', 'plain', '"one", "two"', '"tag"\r\n']) {
    assert.equal(await deleter.deleteIfMatch({ ...target, etag }, signal), 'unconfirmed');
  }
  for (const key of ['', 'a/../b', 'a/./b', 'a\0b']) {
    assert.equal(await deleter.deleteIfMatch({ ...target, key }, signal), 'unconfirmed');
  }
  assert.equal(calls, 0);
});

test('leaves absent, stale, failed and ambiguous results unconfirmed without a second request', async () => {
  const signal = new AbortController().signal;
  for (const [status, headers] of [
    [404, confirmedHeaders], [412, confirmedHeaders], [409, confirmedHeaders], [503, confirmedHeaders],
    [200, {}], [204, {}], [202, confirmedHeaders],
    [204, { ...confirmedHeaders, 'x-amz-delete-marker': 'true' }],
    [204, { ...confirmedHeaders, 'x-amz-version-id': 'version' }],
    [307, { ...confirmedHeaders, location: 'https://elsewhere.example/object' }]
  ] as const) {
    let calls = 0;
    const deleter = bind(async (input) => {
      calls++;
      assert.equal((input as Request).redirect, 'manual');
      return new Response(null, { status, headers: new Headers(Object.entries(headers)) });
    });
    assert.equal(await deleter.deleteIfMatch(target, signal), 'unconfirmed', `status ${status}`);
    assert.equal(calls, 1, `status ${status}`);
  }
  const withoutQualification = createS3ObjectDeleter(config, epoch, { timeoutMs: 1000, fetch: async () => {
    throw new Error('unqualified configuration must not dispatch');
  } });
  assert.equal(withoutQualification(id), null);
  let calls = 0;
  const lost = bind(async () => { calls++; throw new Error('lost response'); });
  assert.equal(await lost.deleteIfMatch(target, signal), 'unconfirmed');
  assert.equal(calls, 1);
});

test('pre-abort prevents dispatch and in-flight abort cannot confirm a late response', async () => {
  const controller = new AbortController();
  let calls = 0;
  const entered = Promise.withResolvers<Request>();
  const pending = Promise.withResolvers<Response>();
  const deleter = bind(async (input) => {
    calls++;
    entered.resolve(input as Request);
    return pending.promise;
  });
  assert.equal(await deleter.deleteIfMatch(target, AbortSignal.abort()), 'unconfirmed');
  assert.equal(calls, 0);
  const result = deleter.deleteIfMatch(target, controller.signal);
  const request = await entered.promise;
  controller.abort();
  assert.equal(request.signal.aborted, true);
  assert.equal(await result, 'unconfirmed');
  pending.resolve(new Response(null, { status: 204, headers: confirmedHeaders }));
  assert.equal(calls, 1);
});

test('times out a stalled fetch without retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = Promise.withResolvers<Request>();
  let calls = 0;
  const deleter = bind(async (input) => {
    calls++;
    entered.resolve(input as Request);
    return new Promise<Response>(() => {});
  });
  const result = deleter.deleteIfMatch(target, new AbortController().signal);
  const request = await entered.promise;
  t.mock.timers.tick(options.timeoutMs);
  assert.equal(await result, 'unconfirmed');
  assert.equal(request.signal.aborted, true);
  assert.equal(calls, 1);
});
