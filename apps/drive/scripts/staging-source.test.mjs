import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStagingSource } from './staging-source.mjs';

const source = {
  repository: 'TogetherWeOwn/qerith',
  event: 'workflow_dispatch',
  ref: 'refs/heads/main',
  sha: '0123456789abcdef0123456789abcdef01234567',
  checkoutSha: '0123456789abcdef0123456789abcdef01234567',
};

test('accepts a matching main dispatch checkout', () => {
  assert.doesNotThrow(() => assertStagingSource(source));
});

test('rejects untrusted source context and mismatched checkouts', () => {
  for (const change of [
    { repository: 'fork/qerith' },
    { event: 'pull_request' },
    { ref: 'refs/tags/main' },
    { ref: 'refs/heads/main-other' },
    { sha: 'HEAD' },
    { sha: source.sha.toUpperCase() },
    { sha: null },
    { checkoutSha: 'f'.repeat(40) },
    { checkoutSha: undefined },
  ]) {
    assert.throws(() => assertStagingSource({ ...source, ...change }));
  }
});
