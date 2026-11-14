import assert from 'node:assert/strict';
import test from 'node:test';

test('discovers colocated TypeScript tests', () => {
  assert.equal(typeof process.versions.node, 'string');
});
