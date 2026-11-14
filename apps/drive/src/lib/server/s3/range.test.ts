import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateRange } from './range.ts';

test('accepts single bounded, open and suffix byte ranges', () => {
  for (const range of ['bytes=0-0', 'bytes=2-999', 'bytes=2-', 'bytes=-3', 'bytes=-99', 'Bytes=0-1', 'BYTES=-3']) {
    assert.equal(validateRange(range), range.replace(/^bytes=/i, 'bytes='));
  }
});

test('rejects malformed, multiple, reversed and unsafe byte ranges', () => {
  for (const range of [
    'bytes=-', 'bytes=-0', 'bytes=3-2', 'bytes=0-1,3-4', 'bytes= 0-1',
    'items=0-1', 'bytes=9007199254740992-', 'bytes=-9007199254740992',
  ]) {
    assert.throws(() => validateRange(range), /Invalid byte range/);
  }
});
