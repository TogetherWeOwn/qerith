import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { uploadPart, type UploadPartDependencies } from '../src/lib/server/upload-part';

const origin = 'https://example.test';
const id = '12345678-1234-1234-1234-123456789abc';
const limit = 16 * 1024 * 1024;
const put = (size = 1, length = size, from = origin) => new Request(`${origin}/api/uploads/${id}/parts/1`, {
  method: 'PUT', body: new Uint8Array(size), headers: { origin: from, 'content-length': String(length) }
});
const sendNever = () => { assert.fail('unexpected provider send'); };

function streamedPart(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const request = new Request(`${origin}/api/uploads/${id}/parts/1`, {
    method: 'PUT', body, signal, duplex: 'half', headers: { origin, 'content-length': '1' }
  } as RequestInit & { duplex: 'half' });
  let claims = 0, sends = 0;
  const result = uploadPart(request, id, '1', {
    authorize: async () => ({ claim: async () => { claims++; return null; } }),
    send: async () => { sends++; return null; }
  });
  return { request, result, assertNoMutation: () => { assert.deepEqual([claims, sends], [0, 0]); } };
}

test('cancels a pending upload body read without waiting for source cleanup', { timeout: 2000 }, async () => {
  const abort = new AbortController();
  const reading = Promise.withResolvers<void>();
  let cancels = 0;
  const { request, result, assertNoMutation } = streamedPart(new ReadableStream({
    pull() { reading.resolve(); },
    cancel() { cancels++; return new Promise(() => {}); }
  }, { highWaterMark: 0 }), abort.signal);
  await reading.promise;
  abort.abort();
  assert.equal((await result).status, 400);
  assert.equal(cancels, 1);
  assert.equal(request.body!.locked, false);
  assertNoMutation();
});

test('times out an upload that sends the declared bytes but not EOF within the total budget', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const readingEof = Promise.withResolvers<void>();
  let pulls = 0, cancels = 0;
  const { request, result, assertNoMutation } = streamedPart(new ReadableStream({
    pull(controller) { if (++pulls === 1) reading.resolve(controller); else readingEof.resolve(); },
    cancel() { cancels++; throw new Error('source cleanup failed'); }
  }, { highWaterMark: 0 }));
  const controller = await reading.promise;
  t.mock.timers.tick(59_999);
  controller.enqueue(new Uint8Array(1));
  await readingEof.promise;
  assert.equal(cancels, 0);
  t.mock.timers.tick(1);
  assert.equal((await result).status, 400);
  assert.equal(cancels, 1);
  assert.equal(request.body!.locked, false);
  assertNoMutation();
});

test('does not claim an already-aborted request even with a complete body', async () => {
  const { result, assertNoMutation } = streamedPart(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1)); controller.close(); }
  }), AbortSignal.abort());
  assert.equal((await result).status, 400);
  assertNoMutation();
});

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

test('claims with the digest of the bounded body it sends exactly once', async () => {
  let digest: string | null = null;
  const receipt = { partNumber: 1, size: limit, etag: '"provider-etag"' };
  const recorded: unknown[] = [];
  const deps: UploadPartDependencies = {
    authorize: async (_, intentId) => ({ claim: async (part, size, sha256) => {
      assert.deepEqual([intentId, part, size], [id, 1, limit]);
      if (digest !== null) return null;
      assert.match(sha256 ?? '', /^[0-9a-f]{64}$/);
      digest = sha256;
      return { objectKey: 'private-key', uploadId: 'provider-id', record: async (result) => { recorded.push(result); } };
    } }),
    send: async (key, uploadId, part, bytes) => {
      assert.deepEqual([key, uploadId, part, bytes.byteLength], ['private-key', 'provider-id', 1, limit]);
      assert.equal(digest, createHash('sha256').update(bytes).digest('hex'));
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

test('a failed digest allows only a legacy claim and preserves its receipt', async (t) => {
  const digest = t.mock.method(crypto.subtle, 'digest', async () => { throw new Error('Digest unavailable'); });
  const receipt = { partNumber: 1, size: 1, etag: '"provider-etag"' };
  const scope = { operationId: 'op', intentId: id, ownerId: 'owner', objectKey: 'key', uploadId: 'upload',
    intentVersion: 2, partNumber: 1, sizeBytes: 1, storageEpoch: 'epoch', endpoint: origin, bucket: 'bucket' };
  const recorded: unknown[] = [];
  let bound = true, claimed = false;
  const send = t.mock.fn(async () => receipt);
  const recordAcknowledged = t.mock.fn(async () => { assert.fail('unexpected evidence write'); });
  const deps: UploadPartDependencies = {
    authorize: async () => ({ claim: async (_, __, sha256) => {
      assert.equal(sha256, null);
      if (bound || claimed) return null;
      claimed = true;
      return { objectKey: scope.objectKey, uploadId: scope.uploadId, byteEvidence: { scope, store: { recordAcknowledged } },
        record: async (outcome) => { recorded.push(outcome); } };
    } }),
    send
  };
  assert.equal((await uploadPart(put(), id, '1', deps)).status, 404);
  assert.equal(send.mock.callCount(), 0);
  bound = false;
  assert.equal((await uploadPart(put(), id, '1', deps)).status, 204);
  assert.equal((await uploadPart(put(), id, '1', deps)).status, 404);
  assert.equal(digest.mock.callCount(), 3);
  assert.equal(send.mock.callCount(), 1);
  assert.equal(recordAcknowledged.mock.callCount(), 0);
  assert.deepEqual(recorded, [receipt]);
});
