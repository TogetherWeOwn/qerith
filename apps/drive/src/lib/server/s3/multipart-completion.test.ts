import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { completionXml } from './multipart-completion.ts';

const mib = 1024 * 1024;

test('preserves ordered opaque quoted ETags and escapes XML', () => {
  const body = completionXml([
    { partNumber: 2, size: 5 * mib, etag: '"a<&>"' },
    { partNumber: 9, size: 1, etag: '"opaque-2"' },
  ]);
  assert.equal(new TextDecoder().decode(body), '<CompleteMultipartUpload><Part><PartNumber>2</PartNumber><ETag>"a&lt;&amp;&gt;"</ETag></Part><Part><PartNumber>9</PartNumber><ETag>"opaque-2"</ETag></Part></CompleteMultipartUpload>');
});

test('rejects bad order, count, sizes and ETags', () => {
  const part = { partNumber: 1, size: 5 * mib, etag: '"x"' };
  assert.throws(() => completionXml([]));
  assert.throws(() => completionXml(Array(10_001).fill(part)));
  assert.throws(() => completionXml(Array(1)));
  assert.throws(() => completionXml([part, ...Array(1)]));
  assert.throws(() => completionXml([{ ...part, etag: `"${'&'.repeat(4 * mib)}"` }]), /exceeds limit/);
  for (const invalid of [0, 10_001, 1.5, NaN]) assert.throws(() => completionXml([{ ...part, partNumber: invalid }]));
  assert.throws(() => completionXml([part, part]));
  assert.throws(() => completionXml([{ ...part, size: 5 * mib - 1 }, { ...part, partNumber: 2 }]));
  for (const size of [-1, 16 * mib + 1, 1.5, NaN]) assert.throws(() => completionXml([{ ...part, size }]));
  for (const etag of ['x', 'W/"x"', '"a"b"', '"x\n"', '"😀"']) {
    assert.throws(() => completionXml([{ ...part, etag }]));
  }
  assert.doesNotThrow(() => completionXml([{ ...part, size: 0 }]));
  assert.doesNotThrow(() => completionXml([{ ...part, size: 16 * mib }]));
  assert.throws(() => completionXml([{ ...part, etag: `"${'x'.repeat(16 * mib)}"` }]), /exceeds limit/);
});
