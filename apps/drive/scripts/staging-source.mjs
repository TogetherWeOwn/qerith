// This check is preparation only; it does not authorize deployment or fixtures.
export function assertStagingSource({ repository, event, ref, sha, checkoutSha }) {
  if (repository !== 'TogetherWeOwn/qerith') throw new Error('unexpected repository');
  if (event !== 'workflow_dispatch') throw new Error('unexpected event');
  if (ref !== 'refs/heads/main') throw new Error('unexpected ref');
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('invalid source SHA');
  }
  if (checkoutSha !== sha) throw new Error('checkout SHA mismatch');
}
