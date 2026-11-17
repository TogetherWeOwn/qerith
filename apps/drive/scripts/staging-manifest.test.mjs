import assert from 'node:assert/strict';
import test from 'node:test';
import { preparationManifest } from './staging-manifest.mjs';

const input = { sha: 'a'.repeat(40), runId: '123', runAttempt: '1' };

test('prepares closed, run-scoped metadata without copying other input', () => {
  const manifest = preparationManifest({ ...input, secret: 'not included' });
  assert.deepEqual(manifest, {
    schema: 'drive-staging-preparation/v1',
    sourceSha: input.sha,
    environment: 'staging',
    runId: '123',
    runAttempt: '1',
    proposedFixturePrefix: 'drive-qualification/123/1/',
    admission: 'closed',
  });
  assert.notEqual(manifest.proposedFixturePrefix,
    preparationManifest({ ...input, runAttempt: '2' }).proposedFixturePrefix);
});

test('rejects malformed metadata instead of creating an unsafe prefix', () => {
  for (const invalid of [
    { sha: 'main' }, { sha: 'A'.repeat(40) }, { runId: '../1' },
    { runId: '0' }, { runAttempt: '' }, { runAttempt: '01' },
  ]) {
    assert.throws(() => preparationManifest({ ...input, ...invalid }));
  }
});
