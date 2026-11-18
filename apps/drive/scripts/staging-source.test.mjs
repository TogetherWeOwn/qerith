import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../../../.github/workflows/drive-staging-preparation.yml', import.meta.url),
  'utf8',
);
const sourceStep = 'Verify dispatch source';
const checkoutStep = 'Verify checked-out commit';
const sourceSha = '0123456789abcdef0123456789abcdef01234567';

function runStep(name, overrides = {}) {
  // Run the workflow's literal Bash block, not a copy of the guard.
  const step = workflow.split('\n      - ').find((step) => step.startsWith(`name: ${name}\n`));
  const block = step?.match(/^        run: \|((?:\n {10}[^\n]*)+)/m)?.[1];
  assert.ok(block, `missing script for ${name}`);
  const script = block.replace(/^ {10}/gm, '');
  const git = `git() {
    [[ "$*" == 'rev-parse --verify HEAD' ]] || return 2
    printf '%s\\n' "$TEST_CHECKOUT_SHA"
    return "$TEST_GIT_STATUS"
  }`;
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `${git}\n${script}`], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: 'TogetherWeOwn/qerith',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: sourceSha,
      TEST_CHECKOUT_SHA: sourceSha,
      TEST_GIT_STATUS: '0',
      ...overrides,
    },
  });
  assert.ifError(result.error);
  return result;
}

function assertRejected(result, reason) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, reason);
}

test('checks the dispatch before checkout and the commit before metadata tests', () => {
  const source = workflow.indexOf(`- name: ${sourceStep}\n`);
  const checkout = workflow.indexOf('- uses: actions/checkout@');
  const commit = workflow.indexOf(`- name: ${checkoutStep}\n`);
  const metadata = workflow.indexOf('- name: Test closed-admission metadata');
  assert.ok(source >= 0 && source < checkout && checkout < commit && commit < metadata);
});

test('accepts a matching main dispatch checkout', () => {
  assert.equal(runStep(sourceStep).status, 0);
  assert.equal(runStep(checkoutStep).status, 0);
});

test('rejects the wrong repository, event or ref before checkout', () => {
  for (const change of [
    { GITHUB_REPOSITORY: 'fork/qerith' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/tags/main' },
    { GITHUB_REF: 'refs/heads/main-other' },
    { GITHUB_REF: 'refs/heads/Main' },
  ]) {
    assertRejected(runStep(sourceStep, change), /unexpected dispatch source/);
  }
});

test('rejects malformed source SHAs independently of checkout identity', () => {
  for (const sha of ['HEAD', sourceSha.toUpperCase(), '']) {
    assertRejected(runStep(sourceStep, { GITHUB_SHA: sha }), /invalid source SHA/);
  }
});

test('rejects a mismatched checkout and a failing Git lookup even if it prints the expected SHA', () => {
  assertRejected(runStep(checkoutStep, { TEST_CHECKOUT_SHA: 'f'.repeat(40) }), /checkout SHA mismatch/);
  assertRejected(runStep(checkoutStep, { TEST_GIT_STATUS: '128' }), /could not resolve checkout HEAD/);
});
