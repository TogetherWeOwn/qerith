import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadPart, type UploadPartDependencies } from '../src/lib/server/upload-part';

const origin = 'https://example.test';
const id = '12345678-1234-1234-1234-123456789abc';
const limit = 16 * 1024 * 1024;
const put = (size = 1, length = size, from = origin) => new Request(`${origin}/api/uploads/${id}/parts/1`, {
  method: 'PUT', body: new Uint8Array(size), headers: { origin: from, 'content-length': String(length) }
});
const sendNever = () => { assert.fail('unexpected provider send'); };

test('denies unwired, cross-origin and unauthorized requests without reading bytes', async () => {
  const request = put();
  const closed = await uploadPart(request, id, '1');
  assert.equal(closed.status, 503);
  assert.equal(closed.headers.get('cache-control'), 'no-store');
  assert.equal(request.bodyUsed, false);
  const deps: UploadPartDependencies = { authorize: async () => null, send: sendNever };
  for (const [request, dependency, status] of [
    [put(1, 1, 'https://other.test'), { ...deps, authorize: sendNever }, 403], [put(), deps, 404]] as const) {
    const response = await uploadPart(request, id, '1', dependency);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(request.bodyUsed, false);
  }
});

test('rejects invalid selectors and short, oversized or understated bodies before claiming', async () => {
  let claims = 0;
  const deps: UploadPartDependencies = { authorize: async () => ({ claim: async () => { claims++; return null; } }), send: sendNever };
  assert.equal((await uploadPart(put(), id, '01', deps)).status, 400);
  assert.equal((await uploadPart(put(1, limit + 1), id, '1', deps)).status, 413);
  assert.equal((await uploadPart(put(1, 2), id, '1', deps)).status, 400);
  assert.equal((await uploadPart(put(2, 1), id, '1', deps)).status, 400);
  assert.equal(claims, 0);
});

test('sends the bounded part once for a fresh claim and never exposes storage identifiers', async () => {
  let claimed = false;
  const receipt = { partNumber: 1, size: limit, etag: '"provider-etag"' };
  const recorded: unknown[] = [];
  const deps: UploadPartDependencies = {
    authorize: async (_, intentId) => ({ claim: async (part, size) => {
      assert.deepEqual([intentId, part, size], [id, 1, limit]);
      if (claimed) return null;
      claimed = true;
      return { objectKey: 'private-key', uploadId: 'provider-id', record: async (result) => { recorded.push(result); } };
    } }),
    send: async (key, uploadId, part, bytes) => {
      assert.deepEqual([key, uploadId, part, bytes.byteLength], ['private-key', 'provider-id', 1, limit]);
      return receipt;
    }
  };
  const response = await uploadPart(put(limit), id, '1', deps);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal((await uploadPart(put(limit), id, '1', deps)).status, 404);
  assert.deepEqual(recorded, [receipt]);
});

test('keeps lost acknowledgments and failed sends uncertain without retries', async () => {
  for (const failure of ['claim', 'send', 'record']) {
    let sends = 0;
    const recorded: unknown[] = [];
    const receipt = { partNumber: 1, size: 1, etag: '"provider-etag"' };
    const fail = () => { throw new Error('private-key'); };
    const result = await uploadPart(put(), id, '1', {
      authorize: async () => ({ claim: async () => failure === 'claim' ? fail() : {
        objectKey: 'private-key', uploadId: 'provider-id', record: async (outcome) => {
          recorded.push(outcome);
          if (failure === 'record') fail();
        }
      } }),
      send: async () => { sends++; return failure === 'send' ? fail() : receipt; }
    });
    assert.equal(result.status, 409);
    assert.equal(await result.text(), 'Upload part outcome unknown');
    assert.equal(sends, failure === 'claim' ? 0 : 1);
    assert.deepEqual(recorded, failure === 'claim' ? [] : [failure === 'send' ? null : receipt]);
  }
});
