import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = 'TogetherWeOwn/qerith';
const main = 'refs/heads/main';
const sha = /^[0-9a-f]{40}$/;
const positiveInteger = /^[1-9][0-9]*$/;

export const requiredCases = Object.freeze([
  'sha-bound-readiness',
  'passkey-positive',
  'passkey-negative',
  'invite-acceptance',
  'member-revocation',
  'cross-user-denial',
  'authenticated-file-access',
  'unauthenticated-file-denial',
  's3-multipart',
  's3-range',
  's3-retry',
  's3-persistence',
  'large-transfer-hash',
  'interrupted-transfer-resume',
  'folder-operations',
  'share-and-revoke',
  'delete-envelope',
  'delete-boundary-and-safe-fallback',
  'delete-rollback-and-retry',
  'delete-provider-proof',
  'migration-ledger',
  'time-travel-bookmark',
  'rollback-or-disablement',
  'zero-idle-inventory',
  'prefix-cleanup-verified',
]);

function requireMatch(pattern, value) {
  return typeof value === 'string' && pattern.test(value);
}

export function assertDispatch(env, cwd = process.cwd()) {
  if (env.GITHUB_REPOSITORY !== repo || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== main) {
    throw new Error('Qualification requires a same-repo manual dispatch on main.');
  }
  const testedSha = env.TESTED_SHA;
  if (!requireMatch(sha, testedSha) || testedSha !== env.GITHUB_SHA) {
    throw new Error('tested_sha must be the lowercase 40-hex dispatch SHA.');
  }
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('rev-parse', '--verify', 'HEAD') !== testedSha) {
    throw new Error('Qualification checkout does not match the dispatch SHA.');
  }
  try {
    git('merge-base', '--is-ancestor', testedSha, 'refs/remotes/origin/main');
  } catch {
    throw new Error('Qualification SHA is not proven to be on origin/main.');
  }
  return testedSha;
}

export function assertQualificationJob(env, cwd) {
  const testedSha = assertDispatch(env, cwd);
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, GITHUB_WORKFLOW_REF: workflow } = env;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_JOB !== 'qualification' ||
      workflow !== `${repo}/.github/workflows/drive-staging-qualification.yml@${main}` ||
      !requireMatch(positiveInteger, runId) || !requireMatch(positiveInteger, attempt)) {
    throw new Error('Requires the protected staging qualification job.');
  }
  return { sha: testedSha, runId, attempt };
}

// This is a policy predicate, not a live-evidence source or an artifact writer.
export function qualificationReceiptName(env, evidence, status, cwd) {
  const testedSha = assertDispatch(env, cwd);
  const runId = env.GITHUB_RUN_ID;
  const attempt = env.GITHUB_RUN_ATTEMPT;
  if (!requireMatch(positiveInteger, runId) || !requireMatch(positiveInteger, attempt) ||
      status !== 'success' || evidence?.mode !== 'full-v0' || evidence.sha !== testedSha ||
      evidence.runId !== runId || evidence.attempt !== attempt) {
    throw new Error('Receipt requires successful full-v0 evidence for this SHA, run and attempt.');
  }
  const results = evidence.results;
  if (!results || Object.keys(results).length !== requiredCases.length ||
      !requiredCases.every(name => Object.hasOwn(results, name) && results[name] === 'pass')) {
    throw new Error('Every required qualification case and verified cleanup must pass.');
  }
  return `drive-staging-qualification-${testedSha}-attempt-${attempt}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assertDispatch(process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
