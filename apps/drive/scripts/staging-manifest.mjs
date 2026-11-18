// This is preparation metadata, not permission to deploy or create fixtures.
export function preparationManifest({ sha, runId, runAttempt }) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('invalid source SHA');
  if (typeof runId !== 'string' || !/^[1-9][0-9]*$/.test(runId)) throw new Error('invalid run ID');
  if (typeof runAttempt !== 'string' || !/^[1-9][0-9]*$/.test(runAttempt)) throw new Error('invalid run attempt');

  return {
    schema: 'drive-staging-preparation/v1',
    sourceSha: sha,
    environment: 'staging',
    runId,
    runAttempt,
    proposedFixturePrefix: `drive-qualification/${runId}/${runAttempt}/`,
    admission: 'closed',
  };
}

// Matching preparation metadata does not authorize fixture creation or cleanup.
export function assertPreparationMatchesRun(manifest, run) {
  const expected = Object.entries(preparationManifest(run));
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || Reflect.ownKeys(manifest).length !== expected.length) {
    throw new Error('invalid preparation metadata');
  }
  for (const [key, value] of expected) {
    if (!Object.hasOwn(manifest, key) || manifest[key] !== value) {
      throw new Error(`preparation metadata mismatch: ${key}`);
    }
  }
}
