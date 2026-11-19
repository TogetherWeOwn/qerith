import { expect, it } from 'vitest';
import { sealUploadManifest } from '../../drive/src/lib/server/metadata/upload-manifest.ts';

it('seals ordered part evidence with its exact byte count and opaque validators', () => {
  const parts = [
    { partNumber: 1, etag: '"a&b"', size: 5 * 1024 * 1024 },
    { partNumber: 3, etag: '"final"', size: 7 },
  ];
  const result = sealUploadManifest(parts, 5 * 1024 * 1024 + 7);
  parts[0].etag = '"changed"';
  expect(JSON.parse(result.sealedManifest)[0].etag).toBe('"a&b"');
  expect(result.sizeBytes).toBe(5 * 1024 * 1024 + 7);
});

it('accepts provider-valid zero-byte final parts and strips unrelated fields', () => {
  const result = sealUploadManifest([{ partNumber: 4, etag: '""', size: 0, ignored: true }], 0);
  expect(JSON.parse(result.sealedManifest)).toEqual([{ partNumber: 4, etag: '""', size: 0 }]);
  expect(result.sizeBytes).toBe(0);
});

it('rejects malformed, unordered, undersized and mismatched evidence', () => {
  const valid = { partNumber: 1, etag: '"part"', size: 7 };
  for (const [parts, size] of [
    [[], 0],
    [[valid], 8],
    [[{ ...valid, etag: 'unquoted' }], 7],
    [[{ ...valid, size: -1 }], 0],
    [[valid, valid], 14],
    [[valid, { ...valid, partNumber: 2 }], 14],
    [[valid], Number.MAX_SAFE_INTEGER + 1],
    [[valid], -1],
    [[valid], 7.5],
    [[{ ...valid, partNumber: 0 }], 7],
    [[{ ...valid, partNumber: 10_001 }], 7],
    [[{ ...valid, size: 1.5 }], 1.5],
    [[{ ...valid, size: 16 * 1024 * 1024 + 1 }], 16 * 1024 * 1024 + 1],
    [[{ ...valid, etag: '"line\nbreak"' }], 7],
    [[null], 7],
    [new Array(1), 0],
  ]) {
    expect(() => sealUploadManifest(parts, size)).toThrow();
  }
});
