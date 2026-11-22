import assert from 'node:assert/strict';
import test from 'node:test';
import { IoDeadlineExceeded, readBoundedBody, withIoDeadline } from './bounded-io';

const bounds = { signal: new AbortController().signal, maxBytes: 2, timeoutMs: 1_000 };
const chunked = (...chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  },
});

test('reads bounded chunks through EOF and honors an exact length', async () => {
  const body = chunked(Uint8Array.of(1), Uint8Array.of(2));
  assert.deepEqual(await readBoundedBody(body, { ...bounds, exact: true }), Uint8Array.of(1, 2));
  assert.equal(body.locked, false);
  assert.deepEqual(await readBoundedBody(chunked(Uint8Array.of(1)), bounds), Uint8Array.of(1));
  assert.equal(await readBoundedBody(chunked(Uint8Array.of(1)), { ...bounds, exact: true }), null);
});

test('cancels overlong and excessive-chunk bodies without awaiting teardown', { timeout: 2_000 }, async () => {
  for (const [chunk, maxReads, expectedReads] of [[Uint8Array.of(1, 2, 3), undefined, 1],
    [new Uint8Array(), 3, 3]] as const) {
    let reads = 0, cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(chunk); },
      cancel() { cancels++; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    assert.equal(await readBoundedBody(body, { ...bounds, maxReads }), null);
    assert.deepEqual({ reads, cancels, locked: body.locked }, { reads: expectedReads, cancels: 1, locked: false });
  }
});

test('preserves caller abort reasons before and during a read', { timeout: 2_000 }, async () => {
  for (const alreadyAborted of [false, true]) {
    const caller = new AbortController();
    const reason = { message: 'caller stopped' };
    const pulled = Promise.withResolvers<void>();
    const cancelled: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({
      pull() { pulled.resolve(); },
      cancel(error) { cancelled.push(error); return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    if (alreadyAborted) caller.abort(reason);
    const result = readBoundedBody(body, { ...bounds, signal: caller.signal });
    if (!alreadyAborted) {
      await pulled.promise;
      caller.abort(reason);
    }
    await assert.rejects(result, error => error === reason);
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0], reason);
    assert.equal(body.locked, false);
  }
});

test('cancels a body waiting at EOF when the total deadline expires', { timeout: 2_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = Promise.withResolvers<void>();
  let cancelled: unknown;
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (started) waiting.resolve();
      else controller.enqueue(Uint8Array.of(1, 2));
      started = true;
    },
    cancel(reason) { cancelled = reason; throw new Error('cleanup failed'); },
  }, { highWaterMark: 0 });
  const result = readBoundedBody(body, { ...bounds, exact: true });
  await waiting.promise;
  t.mock.timers.tick(bounds.timeoutMs);
  await assert.rejects(result, error => error instanceof IoDeadlineExceeded && error === cancelled);
  assert.equal(body.locked, false);
});

test('checks the monotonic deadline even before the timer runs', async (t) => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  await assert.rejects(withIoDeadline(100, undefined, async ({ check, signal }) => {
    check();
    assert.equal(signal.aborted, false);
    now += 100;
    return 'late result';
  }), IoDeadlineExceeded);
});
