import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createS3Transport } from '../src/lib/server/s3/transport';

const config = { endpoint: 'https://storage.example', bucket: 'test-bucket', region: 'us-east-1', accessKeyId: 'access', secretAccessKey: 'secret' };
const operation = { method: 'GET' as const, key: 'key', maxResponseBytes: 32 * 1024 * 1024 };
const budgets = { timeoutMs: 15, streamBudget: { idleMs: 30, totalMs: 100 } };

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

function streamClock(t: TestContext, now = () => 0) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', now);
  return (ms: number) => t.mock.timers.tick(ms);
}

function controlledDownload({ deferHeaders = false, streamBudget = budgets.streamBudget } = {}) {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let pulls = 0;
  let cancellations = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(output) { source = output; },
    pull() { pulls++; },
    cancel() { cancellations++; return new Promise<void>(() => {}); }
  }, { highWaterMark: 0 }));
  const fetched = Promise.withResolvers<Request>();
  const headers = Promise.withResolvers<Response>();
  if (!deferHeaders) headers.resolve(response);
  const request = createS3Transport(config, { ...budgets, streamBudget,
    fetch: async (input) => { fetched.resolve(input as Request); return headers.promise; }
  });
  return { request, signed: fetched.promise, respond: () => headers.resolve(response), source,
    pulls: () => pulls, cancellations: () => cancellations };
}

test('the headers deadline aborts the request and cancels a late response', async (t) => {
  const tick = streamClock(t);
  const download = controlledDownload({ deferHeaders: true });
  const rejected = assert.rejects(download.request.stream(operation), /stream request failed/);
  const { signal } = await download.signed;
  tick(14);
  assert.equal(signal.aborted, false);
  tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
  download.respond();
  await nextTurn();
  assert.equal(download.cancellations(), 1);
});

test('reads progress past the headers deadline and pause past idle, but not past the total deadline', async (t) => {
  const tick = streamClock(t);
  const inherited = { get idleMs() { return 30; }, get totalMs() { return 100; } };
  const download = controlledDownload({ deferHeaders: true, streamBudget: Object.create(inherited) });
  const stream = download.request.stream(operation);
  const { signal } = await download.signed;
  tick(10);
  download.respond();
  const reader = (await stream).body.getReader();
  assert.equal(download.pulls(), 0);
  for (let byte = 1; byte <= 2; byte++) {
    const pending = reader.read();
    await nextTurn();
    tick(20);
    download.source.enqueue(new Uint8Array([byte]));
    assert.deepEqual((await pending).value, new Uint8Array([byte]));
    if (byte === 1) tick(35);
    assert.equal(download.pulls(), byte);
  }
  tick(14);
  assert.equal(signal.aborted, false);
  tick(1);
  assert.equal(signal.aborted, true);
  assert.equal(download.cancellations(), 1);
  await assert.rejects(reader.read(), /aborted or timed out/);
});

test('empty chunks do not extend demanded-read idle, including a stalled EOF check', async (t) => {
  const tick = streamClock(t);
  const download = controlledDownload();
  const reader = (await download.request.stream({ ...operation, maxResponseBytes: 1 })).body.getReader();
  download.source.enqueue(new Uint8Array([42]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([42]));
  const rejected = assert.rejects(reader.read(), /aborted or timed out/);
  await nextTurn();
  tick(20);
  download.source.enqueue(Object.defineProperty(new Uint8Array(0), 'byteLength', { value: 1 }));
  await nextTurn();
  tick(9);
  assert.equal((await download.signed).signal.aborted, false);
  tick(1);
  await rejected;
  assert.equal((await download.signed).signal.aborted, true);
  assert.equal(download.cancellations(), 1);
});

test('idle includes a fairness yield before the first upstream read', async (t) => {
  let now = 0;
  const tick = streamClock(t, () => now);
  const download = controlledDownload();
  const reader = (await download.request.stream(operation)).body.getReader();
  now = 5;
  const rejected = assert.rejects(reader.read(), /aborted or timed out/);
  await nextTurn();
  now += 31; // Deliver the yield callback before the delayed idle timer callback.
  tick(1);
  await rejected;
  assert.equal(download.pulls(), 0);
});

for (const callerAbort of [true, false]) {
  test(`budgeted ${callerAbort ? 'caller abort' : 'consumer cancellation'} never waits for upstream cancellation`, async (t) => {
    streamClock(t);
    const caller = new AbortController();
    const download = controlledDownload();
    const reader = (await download.request.stream({ ...operation, signal: caller.signal })).body.getReader();
    const pending = reader.read();
    await nextTurn();
    if (callerAbort) {
      caller.abort(new Error('private'));
      await assert.rejects(pending, (error: Error) => error.message === 'S3 stream aborted or timed out');
    } else {
      await reader.cancel('private');
      assert.equal((await pending).done, true);
    }
    assert.equal((await download.signed).signal.aborted, true);
    assert.equal(download.cancellations(), 1);
  });
}

test('normal EOF clears deadlines and detaches the caller signal', async (t) => {
  const tick = streamClock(t);
  const caller = new AbortController();
  const download = controlledDownload();
  const reader = (await download.request.stream({ ...operation, signal: caller.signal })).body.getReader();
  download.source.close();
  assert.equal((await reader.read()).done, true);
  tick(100);
  caller.abort();
  assert.equal((await download.signed).signal.aborted, false);
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
