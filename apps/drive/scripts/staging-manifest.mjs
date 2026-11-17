// This is preparation metadata, not permission to deploy or create fixtures.
export function preparationManifest({ sha, runId, runAttempt }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('invalid source SHA');
  if (!/^[1-9][0-9]*$/.test(runId ?? '')) throw new Error('invalid run ID');
  if (!/^[1-9][0-9]*$/.test(runAttempt ?? '')) throw new Error('invalid run attempt');

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
