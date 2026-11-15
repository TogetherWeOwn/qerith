import assert from 'node:assert/strict';
import test from 'node:test';
import { createS3Transport } from '../src/lib/server/s3/transport';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };
const operation = { method: 'GET' as const, key: 'key', maxResponseBytes: 32 * 1024 * 1024 };

test('streams on demand with a bound larger than a part', async () => {
  let pulls = 0;
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async () => new Response(
    new ReadableStream<Uint8Array>({ pull(controller) {
      if (++pulls <= 3) controller.enqueue(new Uint8Array([pulls]));
      else controller.close();
    } }, { highWaterMark: 0 }), { status: 206, headers: { etag: '"v1"' } }) });
  const result = await request.stream(operation);
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('etag'), '"v1"');
  assert.equal(pulls, 0);
  const reader = result.body.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1]));
  assert.equal(pulls, 1);
  assert.deepEqual((await reader.read()).value, new Uint8Array([2]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([3]));
  assert.equal((await reader.read()).done, true);
});

test('streams more than 16 MiB without assembling the object', async () => {
  let pulls = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async () => new Response(
    new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ < 17) controller.enqueue(chunk);
      else controller.close();
    } }, { highWaterMark: 0 })) });
  const reader = (await request.stream(operation)).body.getReader();
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    assert.equal(part.value, chunk);
  }
  assert.equal(total, 17 * 1024 * 1024);
});

test('rejects overflow and cancels the upstream response', async () => {
  let cancelled = 0;
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async () => new Response(
    new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array([1, 2])); }, cancel() { cancelled++; } }, { highWaterMark: 0 })) });
  const reader = (await request.stream({ ...operation, maxResponseBytes: 3 })).body.getReader();
  assert.equal((await reader.read()).value?.length, 2);
  await assert.rejects(reader.read(), /exceeds limit/);
  assert.equal(cancelled, 1);
});

test('consumer cancellation and idle timeout cancel upstream', async () => {
  let cancelled = 0;
  const request = createS3Transport(config, { timeoutMs: 30, fetch: async () => new Response(
    new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }, { highWaterMark: 0 })) });
  const first = await request.stream(operation);
  await first.body.cancel('private');
  assert.equal(cancelled, 1);
  const second = await request.stream(operation);
  await new Promise((resolve) => setTimeout(resolve, 60));
  await assert.rejects(second.body.getReader().read(), /aborted or timed out/);
  assert.equal(cancelled, 2);
});

test('redacts fetch, source and caller abort errors', async () => {
  const failing = createS3Transport(config, { timeoutMs: 1000, fetch: async () => { throw new Error('secret fetch'); } });
  await assert.rejects(failing.stream(operation), (error: Error) => error.message === 'S3 stream request failed');
  await assert.rejects(failing.stream({ ...operation, headers: { 'x-test': 'secret\nvalue' } }),
    (error: Error) => error.message === 'S3 stream request failed');
  const request = createS3Transport(config, { timeoutMs: 1000, fetch: async () => new Response(
    new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('secret source')); } }, { highWaterMark: 0 })) });
  await assert.rejects((await request.stream(operation)).body.getReader().read(), (error: Error) => error.message === 'S3 stream failed');
  const controller = new AbortController();
  const stalled = createS3Transport(config, { timeoutMs: 1000, fetch: async () => new Response(
    new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } }, { highWaterMark: 0 })) });
  const reader = (await stalled.stream({ ...operation, signal: controller.signal })).body.getReader();
  const pending = reader.read();
  controller.abort(new Error('secret abort'));
  await assert.rejects(pending, (error: Error) => error.message === 'S3 stream aborted or timed out');
});
