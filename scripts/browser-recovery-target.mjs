import { pathToFileURL } from 'node:url';

const repository = 'TogetherWeOwn/qerith';
const shaPattern = /^[0-9a-f]{40}$/;

// Dispatch inputs are assertions to check, never the authority for the target.
export async function resolveRecoveryTarget({ repo, repositoryId, ref, workflow, number, expectedHead, expectedBase }, get) {
  if (repo !== repository || !/^[1-9][0-9]*$/.test(repositoryId) || ref !== 'refs/heads/main' || !shaPattern.test(workflow) ||
      !/^[1-9][0-9]*$/.test(number) || !Number.isSafeInteger(Number(number)) || !shaPattern.test(expectedHead) || !shaPattern.test(expectedBase)) {
    throw new Error('Invalid recovery dispatch identity');
  }
  const pr = await get(`/repos/${repository}/pulls/${number}`);
  const branch = await get(`/repos/${repository}/git/ref/heads/main`);
  if (pr.number !== Number(number) || pr.state !== 'open' ||
      pr.base?.repo?.full_name !== repository || String(pr.base.repo.id) !== repositoryId || pr.base?.ref !== 'main' ||
      pr.head?.repo?.full_name !== repository || String(pr.head.repo.id) !== repositoryId ||
      typeof pr.head?.ref !== 'string' || !pr.head.ref || pr.head.ref === 'main' || pr.head.sha !== expectedHead ||
      branch.ref !== 'refs/heads/main' || branch.object?.type !== 'commit' ||
      branch.object?.sha !== expectedBase || workflow !== expectedBase) {
    throw new Error('Recovery target changed or does not match the expected identity');
  }
  const headBranch = await get(`/repos/${repository}/git/ref/heads/${encodeURIComponent(pr.head.ref)}`);
  if (headBranch.ref !== `refs/heads/${pr.head.ref}` || headBranch.object?.type !== 'commit' || headBranch.object.sha !== expectedHead) {
    throw new Error('Recovery head branch does not match the PR head');
  }
  return { repository, repositoryId, number: Number(number), headRef: pr.head.ref, base: expectedBase, head: expectedHead, workflow };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.GITHUB_TOKEN;
  if (!token || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Expected authenticated dispatch');
  const get = async path => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`GitHub API request failed: ${response.status}`);
    return response.json();
  };
  const target = await resolveRecoveryTarget({ repo: process.env.GITHUB_REPOSITORY, repositoryId: process.env.GITHUB_REPOSITORY_ID, ref: process.env.GITHUB_REF,
    workflow: process.env.GITHUB_SHA, number: process.env.PR_NUMBER, expectedHead: process.env.EXPECTED_HEAD,
    expectedBase: process.env.EXPECTED_BASE }, get);
  console.log(JSON.stringify(target));
}
