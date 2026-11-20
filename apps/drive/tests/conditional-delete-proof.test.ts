import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proveConditionalDelete, type ConditionalDeleteTarget } from '../scripts/conditional-delete-proof';
import { createS3Transport } from '../src/lib/server/s3/transport';

const config = { endpoint: 'https://storage.example.test', bucket: 'isolated-fixture', region: 'auto',
  accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' };
const key = 'conditional-delete/attempt-fixture/object';
const etag = '"probe-mismatch"'; // Also exercises choosing a distinct wrong ETag.
const bytes = new Uint8Array([0, 1, 255]);
const error = (status: number, code: string) => new Response(`<Error><Code>${code}</Code></Error>`, { status });
const object = (body = bytes, pin = etag) => new Response(body, { headers: { etag: pin } });

function fixture(override?: (step: number) => Response | undefined, success = 204) {
  const calls: Request[] = [];
  let present = true; // Freshly created synthetic object in this fixture's private attempt.
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async (input) => {
    const req = input as Request;
    const step = calls.push(req);
    const custom = override?.(step);
    if (custom) return custom;
    if (req.method === 'GET') return present ? object() : error(404, 'NoSuchKey');
    if (req.headers.get('if-match') !== etag) return error(412, 'PreconditionFailed');
    present = false;
    return new Response(null, { status: success });
  } });
  const target: ConditionalDeleteTarget = { request: (op) => request({ ...op, key }), etag, bytes, versioning: 'never-enabled' };
  return { target, calls };
}

function verifyTrace(calls: Request[], length: number) {
  assert.equal(calls.length, length);
  const methods = ['GET', 'DELETE', 'GET', 'DELETE', 'GET'];
  const pins = [etag, '"probe-mismatch-2"', etag, etag, null];
  for (const [i, call] of calls.entries()) {
    assert.equal(call.url, `${config.endpoint}/${config.bucket}/${key}`);
    assert.equal(call.method, methods[i]);
    assert.equal(call.headers.get('if-match'), pins[i]);
    assert.equal(call.redirect, 'manual');
    const signed = /SignedHeaders=([^,]+)/.exec(call.headers.get('authorization') ?? '');
    assert.ok(signed);
    assert.equal(signed[1].split(';').includes('if-match'), pins[i] !== null);
  }
}

test('accepts only a signed matching delete followed by explicit key absence', async () => {
  for (const status of [200, 204]) {
    const { target, calls } = fixture(undefined, status);
    assert.deepEqual(await proveConditionalDelete(target), { passed: true });
    verifyTrace(calls, 5);
  }
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
    const { target, calls } = fixture((step) => {
      if (step !== n) return;
      if (!response) throw new Error('Untrusted provider diagnostics');
      return response;
    });
    assert.deepEqual(await proveConditionalDelete(target), { passed: false, phase });
    verifyTrace(calls, n);
  }
});

test('does not contact storage for unsupported target evidence or cancellation', async () => {
  const { target, calls } = fixture();
  for (const invalid of [{ etag: '*' }, { etag: 'W/"weak"' }, { bytes: new Uint8Array(1025) },
    { versioning: 'suspended' as unknown as ConditionalDeleteTarget['versioning'] }]) {
    assert.deepEqual(await proveConditionalDelete({ ...target, ...invalid }), { passed: false, phase: 'target' });
  }
  assert.deepEqual(await proveConditionalDelete(target, AbortSignal.abort()), { passed: false, phase: 'initial-read' });
  verifyTrace(calls, 0);
});
