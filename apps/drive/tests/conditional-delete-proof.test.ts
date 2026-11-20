import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { proveConditionalDelete, type ConditionalDeleteTarget } from '../scripts/conditional-delete-proof';
import { createS3Transport } from '../src/lib/server/s3/transport';

const config = { endpoint: 'https://storage.example.test', bucket: 'isolated-fixture', region: 'auto',
  accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' };
const key = 'conditional-delete/attempt-fixture/object';
const bytes = new Uint8Array([0, 1, 255]);
const digestTag = (data: Uint8Array) => `"${createHash('md5').update(data).digest('hex')}"`;
const etag = digestTag(bytes);
const wrongEtag = digestTag(new Uint8Array([2]));
const error = (status: number, code: string, fields = '') =>
  new Response(`<Error><Code>${code}</Code>${fields}</Error>`, { status });
const object = (body = bytes, pin = etag) => new Response(body, { headers: { etag: pin } });

function fixture(options: {
  override?: (step: number, request: Request) => Response | Promise<Response> | undefined;
  success?: number;
  successHeaders?: HeadersInit;
  ignoreDigestComparison?: boolean;
  removeDespiteMismatch?: boolean;
} = {}) {
  const calls: Request[] = [];
  let present = true; // Freshly created synthetic object in this fixture's private attempt.
  let cachedPinnedRead = false;
  const fetchFixture = async (req: Request) => {
    const step = calls.push(req);
    const custom = options.override?.(step, req);
    if (custom) return custom;
    const pin = req.headers.get('if-match');
    if (req.method === 'GET') {
      if (req.cache !== 'no-store' && pin === etag && cachedPinnedRead) return object();
      if (pin === etag && present) cachedPinnedRead = true;
      return present ? object() : error(404, 'NoSuchKey', `<Key>${key}</Key>`);
    }
    if (!/^"[0-9a-f]{32}"$/.test(pin ?? '')) return error(412, 'PreconditionFailed');
    if (pin !== etag && !options.ignoreDigestComparison) {
      if (options.removeDespiteMismatch) present = false;
      return error(412, 'PreconditionFailed');
    }
    present = false;
    return new Response(null, { status: options.success ?? 204, headers: options.successHeaders });
  };
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: (input) => fetchFixture(input as Request) });
  const directRead = createS3Transport(config, { timeoutMs: 1000,
    fetch: (input) => fetchFixture(new Request(input, { cache: 'no-store' })) });
  const target: ConditionalDeleteTarget = {
    request: (op) => (op.method === 'GET' && op.cache === 'no-store' ? directRead : request)({ ...op, key }),
    etag, wrongEtag, bytes, versioning: 'never-enabled', readConsistency: 'authoritative',
    matchesBoundKey: (reportedKey: string) => reportedKey === key,
  };
  return { target, calls };
}

function verifyTrace(calls: Request[], length: number) {
  assert.equal(calls.length, length);
  const methods = ['GET', 'DELETE', 'GET', 'DELETE', 'GET'];
  const pins = [etag, wrongEtag, etag, etag, null];
  for (const [i, call] of calls.entries()) {
    assert.equal(call.url, `${config.endpoint}/${config.bucket}/${key}`);
    assert.equal(call.method, methods[i]);
    assert.equal(call.headers.get('if-match'), pins[i]);
    assert.equal(call.redirect, 'manual');
    assert.equal(call.cache, call.method === 'GET' ? 'no-store' : 'default');
    const signed = /SignedHeaders=([^,]+)/.exec(call.headers.get('authorization') ?? '');
    assert.ok(signed);
    assert.equal(signed[1].split(';').includes('if-match'), pins[i] !== null);
  }
}

test('accepts only a signed matching delete followed by explicit key absence', async () => {
  for (const [status, headers] of [
    [204, {}],
    [200, {}],
    [200, { 'content-length': '0' }],
    [200, { 'transfer-encoding': 'Chunked' }],
  ] as const) {
    const { target, calls } = fixture({ success: status, successHeaders: headers });
    assert.deepEqual(await proveConditionalDelete(target), { passed: true });
    verifyTrace(calls, 5);
  }
});

test('does not confuse invalid-tag rejection with generation comparison', async () => {
  const { target, calls } = fixture({ ignoreDigestComparison: true });
  assert.deepEqual(await proveConditionalDelete(target), { passed: false, phase: 'wrong-etag' });
  verifyTrace(calls, 2);
});

test('checks preservation at origin instead of replaying the initial read', async () => {
  const { target, calls } = fixture({ removeDespiteMismatch: true });
  assert.deepEqual(await proveConditionalDelete(target), { passed: false, phase: 'preservation' });
  verifyTrace(calls, 3);
});

test('rejects uncertain or versioned responses without advancing or retrying', async () => {
  for (const [phase, n, response] of [
    ['initial-read', 1, error(404, 'NoSuchKey')],
    ['wrong-etag', 2, new Response(null, { status: 204 })],
    ['wrong-etag', 2, error(412, 'OtherError')],
    ['preservation', 3, error(404, 'NoSuchKey')],
    ['preservation', 3, object(new Uint8Array([0, 1, 254]))],
    ['preservation', 3, object(bytes, '"other-generation"')],
    ['matching-delete', 4, new Response(null, { status: 202 })],
    ['matching-delete', 4, new Response(null, { status: 404 })],
    ['matching-delete', 4, error(200, 'InternalError')],
    ['matching-delete', 4, new Response(' '.repeat(8193))],
    ['matching-delete', 4, new Response(null, { status: 204, headers: { 'x-amz-version-id': 'null' } })],
    ['matching-delete', 4, new Response(null, { status: 204, headers: { 'x-amz-delete-marker': 'false' } })],
    ['matching-delete', 4, undefined], // Lost response, no retry or absence-based success.
    ['absence', 5, object()],
    ['absence', 5, error(403, 'AccessDenied')],
    ['absence', 5, error(404, 'NoSuchBucket')],
    ['absence', 5, new Response(null, { status: 404 })],
    ['absence', 5, new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404, headers: { 'x-amz-delete-marker': 'true' } })],
  ] as const) {
    const { target, calls } = fixture({ override: (step) => {
      if (step !== n) return;
      if (!response) throw new Error('Untrusted provider diagnostics');
      return response;
    } });
    assert.deepEqual(await proveConditionalDelete(target), { passed: false, phase });
    verifyTrace(calls, n);
  }
});

for (const [name, status, headers] of [
  ['length on 204', 204, { 'content-length': '0' }],
  ['transfer coding on 204', 204, { 'transfer-encoding': 'chunked' }],
  ['conflicting framing on 200', 200, { 'transfer-encoding': 'chunked', 'content-length': '0' }],
  ['repeated chunked coding on 200', 200, { 'transfer-encoding': 'chunked, chunked' }],
] as const) {
  test(`rejects ${name} before checking absence`, async () => {
    const { target, calls } = fixture({ success: status, successHeaders: headers });
    assert.deepEqual(await proveConditionalDelete(target), { passed: false, phase: 'matching-delete' });
    verifyTrace(calls, 4);
  });
}

test('rejects contradictory or malformed length metadata on a bodyless acknowledgment', async () => {
  for (const length of ['1', '0, 0', 'invalid']) {
    const { target, calls } = fixture({ success: 200, successHeaders: { 'content-length': length } });
    assert.deepEqual(await proveConditionalDelete(target), { passed: false, phase: 'matching-delete' });
    verifyTrace(calls, 4);
  }
});

test('rejects a mismatched or ambiguous key in an absence response', async () => {
  for (const fields of ['<Key>another-object</Key>', '<Key/>', `<Key>${key}</Key><Key>${key}</Key>`,
    `<Detail><Key>${key}</Key></Detail>`, `<Key xmlns="urn:other">${key}</Key>`]) {
    const { target, calls } = fixture({ override: (step) => step === 5 ? error(404, 'NoSuchKey', fields) : undefined });
    assert.deepEqual(await proveConditionalDelete(target), { passed: false, phase: 'absence' });
    verifyTrace(calls, 5);
  }
});

test('does not contact storage for unsupported target evidence or cancellation', async () => {
  const { target, calls } = fixture();
  for (const invalid of [{ etag: '*' }, { etag: 'W/"weak"' }, { bytes: new Uint8Array(1025) },
    ...[undefined, '*', 'W/"weak"', etag, `"${'0'.repeat(255)}"`].map((wrongEtag) => ({ wrongEtag })),
    { readConsistency: 'eventual' }, { versioning: 'suspended' }]) {
    assert.deepEqual(await proveConditionalDelete({ ...target, ...invalid } as ConditionalDeleteTarget), { passed: false, phase: 'target' });
  }
  assert.deepEqual(await proveConditionalDelete(target, AbortSignal.abort()), { passed: false, phase: 'initial-read' });
  verifyTrace(calls, 0);
});

test('forwards in-flight cancellation and does not advance on a late response', { timeout: 3000 }, async () => {
  const started = Promise.withResolvers<Request>();
  const reply = Promise.withResolvers<Response>();
  const stop = new AbortController();
  const { target, calls } = fixture({ override: (step, request) => {
    if (step !== 2) return;
    started.resolve(request);
    return reply.promise;
  } });
  const proof = proveConditionalDelete(target, stop.signal);
  const active = await started.promise;
  stop.abort();
  assert.ok(active.signal.aborted);
  reply.resolve(error(412, 'PreconditionFailed'));
  assert.deepEqual(await proof, { passed: false, phase: 'wrong-etag' });
  verifyTrace(calls, 2);
});
