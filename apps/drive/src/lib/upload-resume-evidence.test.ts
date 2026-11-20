import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyUploadResumePrefix } from './upload-resume-evidence';

const partBytes = 16 * 1024 * 1024;
const first = new Uint8Array(partBytes).fill(9);
const last = Uint8Array.of(1, 2, 3);
const declaredSize = first.length + last.length;

function evidencePart(partNumber: number, bytes: Uint8Array) {
  return { partNumber, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const firstPart = evidencePart(1, first);
const lastPart = evidencePart(2, last);

class ObservedBlob extends Blob {
  readonly slices: [number, number][] = [];
  override slice(start: number, end: number): Blob {
    this.slices.push([start, end]);
    return super.slice(start, end);
  }
}

test('verifies a prefix, a short last part, and an exact 16 MiB boundary', async () => {
  const file = new ObservedBlob([first, last]);
  assert.deepEqual(await verifyUploadResumePrefix(file, { declaredSize, parts: [firstPart] }),
    { parts: 1, bytes: partBytes });
  assert.deepEqual(file.slices, [[0, partBytes]]);
  file.slices.length = 0;
  assert.deepEqual(await verifyUploadResumePrefix(file, { declaredSize, parts: [firstPart, lastPart] }),
    { parts: 2, bytes: declaredSize });
  assert.deepEqual(file.slices, [[0, partBytes], [partBytes, declaredSize]]);
  const repicked = new File([first], 'renamed.bin', { lastModified: 123 });
  assert.deepEqual(await verifyUploadResumePrefix(repicked, { declaredSize: partBytes, parts: [firstPart] }),
    { parts: 1, bytes: partBytes });
});

test('returns no usable prefix if any hash mismatches, even after matching earlier parts', async () => {
  const file = new ObservedBlob([first, Uint8Array.of(1, 2, 4)]);
  assert.equal(await verifyUploadResumePrefix(file, { declaredSize, parts: [firstPart, lastPart] }), null);
  assert.deepEqual(file.slices, [[0, partBytes], [partBytes, declaredSize]]);
  file.slices.length = 0;
  assert.equal(await verifyUploadResumePrefix(file, {
    declaredSize, parts: [{ ...firstPart, sha256: '0'.repeat(64) }, lastPart],
  }), null);
  assert.deepEqual(file.slices, [[0, partBytes]]);
});

test('distinguishes an empty prefix from a verified zero-byte part', async () => {
  const file = new ObservedBlob();
  const empty = evidencePart(1, new Uint8Array());
  assert.deepEqual(await verifyUploadResumePrefix(file, { declaredSize: 0, parts: [] }), { parts: 0, bytes: 0 });
  assert.deepEqual(file.slices, []);
  assert.deepEqual(await verifyUploadResumePrefix(file, { declaredSize: 0, parts: [empty] }), { parts: 1, bytes: 0 });
  assert.deepEqual(file.slices, [[0, 0]]);
  assert.equal(await verifyUploadResumePrefix(file, { declaredSize: 0, parts: [{ ...empty, sha256: lastPart.sha256 }] }), null);
});

test('rejects malformed evidence, wrong sizes, and noncontiguous parts before any slice', async () => {
  const file = new ObservedBlob([first, last]);
  const invalid = [
    null, { declaredSize }, { declaredSize, parts: {} }, { declaredSize, parts: [], extra: true },
    { declaredSize: String(declaredSize), parts: [] }, { declaredSize: declaredSize - 1, parts: [] },
    ...[
      Array(321).fill(firstPart), [lastPart, firstPart], [firstPart, firstPart],
      [firstPart, { ...lastPart, partNumber: 3 }], [firstPart, ,],
      [firstPart, { ...lastPart, sizeBytes: partBytes }], [{ ...firstPart, sizeBytes: 0 }],
      [firstPart, { ...lastPart, sha256: lastPart.sha256.toUpperCase() }],
      [firstPart, { ...lastPart, sha256: `${lastPart.sha256}\n` }],
      [firstPart, { ...lastPart, sha256: 'g'.repeat(64) }],
      [firstPart, { ...lastPart, etag: 'not-byte-evidence' }],
    ].map((parts) => ({ declaredSize, parts })),
  ];
  for (const evidence of invalid) assert.equal(await verifyUploadResumePrefix(file, evidence), null);
  assert.deepEqual(file.slices, []);
});

test('enforces the 5 GiB sequential picker limit even for an empty prefix', async () => {
  const limit = 5 * 1024 ** 3;
  for (const size of [limit, limit + 1]) {
    const file = new ObservedBlob();
    Object.defineProperty(file, 'size', { value: size }); // Model the limit without allocating GiBs.
    assert.deepEqual(await verifyUploadResumePrefix(file, { declaredSize: size, parts: [] }),
      size === limit ? { parts: 0, bytes: 0 } : null);
    assert.deepEqual(file.slices, []);
  }
});

test('fails closed on short or unreadable slices and unavailable hashing', async (t) => {
  const file = new Blob([last]);
  const evidence = { declaredSize: file.size, parts: [evidencePart(1, last)] };
  const slice = t.mock.method(file, 'slice', () => new Blob());
  assert.equal(await verifyUploadResumePrefix(file, evidence), null);
  slice.mock.mockImplementation(() => { throw new Error('file unavailable'); });
  assert.equal(await verifyUploadResumePrefix(file, evidence), null);
  slice.mock.restore();
  t.mock.method(crypto.subtle, 'digest', async () => { throw new Error('digest unavailable'); });
  assert.equal(await verifyUploadResumePrefix(file, evidence), null);
});
