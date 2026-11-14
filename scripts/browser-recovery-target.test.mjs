import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRecoveryTarget } from './browser-recovery-target.mjs';

const repo = 'TogetherWeOwn/qerith';
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const input = { repo, repositoryId: '123', ref: 'refs/heads/main', workflow: base, number: '7', expectedHead: head, expectedBase: base };
const pr = () => ({ number: 7, state: 'open', base: { repo: { full_name: repo, id: 123 }, ref: 'main' },
  head: { repo: { full_name: repo, id: 123 }, ref: 'feature/test', sha: head } });
const branch = () => ({ ref: 'refs/heads/main', object: { type: 'commit', sha: base } });
const headBranch = () => ({ ref: 'refs/heads/feature/test', object: { type: 'commit', sha: head } });
const api = (pull = pr(), ref = branch(), headRef = headBranch()) => async path => {
  if (path === `/repos/${repo}/pulls/7`) return pull;
  if (path === `/repos/${repo}/git/ref/heads/main`) return ref;
  if (path === `/repos/${repo}/git/ref/heads/feature%2Ftest`) return headRef;
  throw new Error('Unexpected request');
};

test('pins the live PR and target branch after validating dispatch assertions', async () => {
  assert.deepEqual(await resolveRecoveryTarget(input, api()), { repository: repo, repositoryId: '123', number: 7, headRef: 'feature/test', base, head, workflow: base });
});

test('rejects untrusted or drifting dispatch and API identities', async () => {
  for (const change of [
    { number: '7/../../other' }, { repo: 'other/repo' }, { ref: 'refs/heads/other' },
    { expectedHead: 'x'.repeat(40) }, { expectedBase: head }, { workflow: head },
  ]) await assert.rejects(resolveRecoveryTarget({ ...input, ...change }, api()));
  for (const change of [
    { state: 'closed' }, { number: 8 }, { base: { repo: { full_name: repo }, ref: 'other' } },
    { head: { repo: { full_name: 'fork/qerith' }, sha: head } },
    { head: { repo: { full_name: repo }, sha: base } },
  ]) await assert.rejects(resolveRecoveryTarget(input, api({ ...pr(), ...change })));
  await assert.rejects(resolveRecoveryTarget(input, api(pr(), { ...branch(), object: { type: 'commit', sha: head } })));
  await assert.rejects(resolveRecoveryTarget(input, api(pr(), branch(), { ...headBranch(), object: { type: 'commit', sha: base } })));
  await assert.rejects(resolveRecoveryTarget(input, api({ ...pr(), head: { ...pr().head, repo: { full_name: repo, id: 456 } } })));
  await assert.rejects(resolveRecoveryTarget(input, async () => { throw new Error('unavailable'); }));
});
