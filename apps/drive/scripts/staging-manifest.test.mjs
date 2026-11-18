import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPreparationMatchesRun, preparationManifest } from './staging-manifest.mjs';

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
});

test('rejects malformed metadata instead of creating an unsafe prefix', () => {
  for (const invalid of [
    { sha: 'main' }, { sha: 'A'.repeat(40) }, { runId: '../1' },
    { runId: '0' }, { runAttempt: '' }, { runAttempt: '01' },
    { runId: 123 }, { runAttempt: 1 }, { sha: { toString: () => input.sha } },
  ]) {
    assert.throws(() => preparationManifest({ ...input, ...invalid }));
  }
});

test('checks all preparation fields against the current run without granting admission', () => {
  const manifest = preparationManifest(input);
  assert.doesNotThrow(() => assertPreparationMatchesRun(manifest, input));
  for (const [key, value] of Object.entries(manifest)) {
    assert.throws(() => assertPreparationMatchesRun({ ...manifest, [key]: `${value}x` }, input));
    const missing = { ...manifest };
    delete missing[key];
    assert.throws(() => assertPreparationMatchesRun(missing, input));
  }
  assert.throws(() => assertPreparationMatchesRun(null, input));
  assert.throws(() => assertPreparationMatchesRun(Object.create(manifest), input));
});

test('rejects metadata with fields outside the v1 contract', () => {
  const manifest = { ...preparationManifest(input), extra: 'not allowed' };
  assert.throws(() => assertPreparationMatchesRun(manifest, input));
});

test('binds metadata to the exact SHA, run ID and attempt', () => {
  const manifest = preparationManifest(input);
  for (const change of [{ sha: 'b'.repeat(40) }, { runId: '456' }, { runAttempt: '2' }]) {
    const run = { ...input, ...change };
    const next = preparationManifest(run);
    assert.equal(next.sourceSha, run.sha);
    assert.equal(next.proposedFixturePrefix, `drive-qualification/${run.runId}/${run.runAttempt}/`);
    assert.doesNotThrow(() => assertPreparationMatchesRun(next, run));
    assert.throws(() => assertPreparationMatchesRun(manifest, run));
  }
});
