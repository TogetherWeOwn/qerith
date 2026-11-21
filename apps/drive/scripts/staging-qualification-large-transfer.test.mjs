import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyQualificationLargeDownload } from './staging-qualification-large-transfer.mjs';

const headers = { 'content-type': 'application/octet-stream', 'content-length': '5368709120' };
// Generated independently with Python hashlib over 640 blocks of 8 MiB of ASCII 'a'.
const digest = '58209ffbbdecf43d7140fe7e7c570fd0c71758a6bace32fc82a6e2ce7b7a6132';

function largeResponse({ corrupt = false, extra = false } = {}) {
  const block = new Uint8Array(8 * 1024 ** 2).fill(0x61);
  let blocks = 640;
  return new Response(new ReadableStream({
    pull(controller) {
      if (blocks === 0) {
        if (extra) controller.enqueue(new Uint8Array(1));
        controller.close();
      } else if (--blocks === 0 && corrupt) {
        const changed = block.slice();
        changed[changed.length - 1] = 0x62;
        controller.enqueue(changed);
      } else {
        controller.enqueue(block);
      }
    },
  }, { highWaterMark: 0 }), { headers });
}

test('streams exactly five GiB and matches the independently hashed fixture', async () => {
  assert.deepEqual(await verifyQualificationLargeDownload(largeResponse(), digest), { 'large-transfer-hash': 'pass' });
});

test('rejects an exact-length one-byte corruption and an overlong stream', async () => {
  await assert.rejects(verifyQualificationLargeDownload(largeResponse({ corrupt: true }), digest), /SHA-256/);
  await assert.rejects(verifyQualificationLargeDownload(largeResponse({ extra: true }), digest), /exceeded five GiB/);
});

test('rejects misleading response metadata before pulling and rejects a short body despite its header', async () => {
  for (const overrides of [
    { status: 206 }, { headers: { ...headers, 'content-length': '5368709119' } },
    { headers: { ...headers, 'content-range': 'bytes 0-5368709119/5368709120' } },
    { headers: { ...headers, 'content-encoding': 'gzip' } },
  ]) {
    let cancelled = false;
    const stream = new ReadableStream({
      pull() { assert.fail('invalid response should not be read'); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await assert.rejects(verifyQualificationLargeDownload(new Response(stream, { headers, ...overrides }), digest),
      /Invalid full large-transfer download/);
    assert.equal(cancelled, true);
  }
  await assert.rejects(verifyQualificationLargeDownload(new Response(new Uint8Array(1), { headers }), digest),
    /did not match the upload length/);
});

test('a body read error is sanitized and releases the reader lock', async () => {
  let reads = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (++reads === 1) controller.enqueue(new Uint8Array([0x61]));
      else controller.error(new Error('fixture transport detail'));
    },
  }, { highWaterMark: 0 });
  await assert.rejects(verifyQualificationLargeDownload(new Response(stream, { headers }), digest),
    { message: 'Large-transfer download stream failed.' });
  assert.equal(reads, 2);
  assert.equal(stream.locked, false);
});

test('cancellation settles a pending body read without returning transfer evidence', async () => {
  const abort = new AbortController();
  const pulling = Promise.withResolvers();
  const release = Promise.withResolvers();
  let cleaned = false;
  const stream = new ReadableStream({
    pull() { pulling.resolve(); },
    async cancel() { await release.promise; cleaned = true; },
  }, { highWaterMark: 0 });
  let settled = false;
  const result = assert.rejects(verifyQualificationLargeDownload(new Response(stream, { headers }), digest, abort.signal),
    { name: 'AbortError' }).finally(() => { settled = true; });
  await Promise.race([pulling.promise, result]);
  abort.abort();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    release.resolve();
    await result;
  }
  assert.equal(cleaned, true);
  assert.equal(stream.locked, false);
});
