import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertDispatch, qualificationReceiptName } from './staging-qualification.mjs';

function history(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'drive-qualification-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Drive', '-c', 'user.email=drive@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main', '--template=');
  git('commit', '-q', '--allow-empty', '-m', 'ancestor');
  const ancestor = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'dispatch');
  const head = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'main advanced');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-q', '--detach', head);
  const env = {
    GITHUB_REPOSITORY: 'TogetherWeOwn/qerith',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: head,
    TESTED_SHA: head,
    GITHUB_RUN_ID: '182',
    GITHUB_RUN_ATTEMPT: '3',
  };
  return { cwd, git, ancestor, env };
}

test('dispatch, checkout and fetched main history must independently agree', t => {
  const { cwd, git, ancestor, env } = history(t);
  assert.equal(assertDispatch(env, cwd), env.GITHUB_SHA);
  for (const override of [
    { GITHUB_REPOSITORY: 'fork/qerith' },
    { GITHUB_EVENT_NAME: 'workflow_call' },
    { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_REF: 'refs/tags/main' },
    { TESTED_SHA: ancestor },
  ]) {
    assert.throws(() => assertDispatch({ ...env, ...override }, cwd), /manual dispatch on main|40-hex dispatch SHA/);
  }
  for (const bad of [undefined, '', 'A'.repeat(40), 'a'.repeat(39), `${env.TESTED_SHA}\n`, 'HEAD']) {
    assert.throws(() => assertDispatch({ ...env, TESTED_SHA: bad, GITHUB_SHA: bad }, cwd), /40-hex/);
  }
  git('switch', '-q', '--detach', ancestor);
  assert.throws(() => assertDispatch(env, cwd), /checkout/);
  git('commit', '-q', '--allow-empty', '-m', 'off-main');
  const offMain = git('rev-parse', 'HEAD');
  assert.throws(() => assertDispatch({ ...env, TESTED_SHA: offMain, GITHUB_SHA: offMain }, cwd), /origin\/main/);
  git('switch', '-q', '--detach', env.GITHUB_SHA);
  git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.throws(() => assertDispatch(env, cwd), /origin\/main/);
});

test('only a complete successful full-v0 run has the pinned consumer name', t => {
  const { cwd, env, ancestor } = history(t);
  // Keep this fixture independent so removing a case from the policy cannot weaken the test.
  const results = {
    'sha-bound-readiness': 'pass',
    'passkey-positive': 'pass',
    'passkey-negative': 'pass',
    'invite-acceptance': 'pass',
    'member-revocation': 'pass',
    'cross-user-denial': 'pass',
    'authenticated-file-access': 'pass',
    'unauthenticated-file-denial': 'pass',
    's3-multipart': 'pass',
    's3-range': 'pass',
    's3-retry': 'pass',
    's3-persistence': 'pass',
    'large-transfer-hash': 'pass',
    'interrupted-transfer-resume': 'pass',
    'folder-operations': 'pass',
    'share-and-revoke': 'pass',
    'delete-envelope': 'pass',
    'delete-boundary-and-safe-fallback': 'pass',
    'delete-rollback-and-retry': 'pass',
    'delete-provider-proof': 'pass',
    'migration-ledger': 'pass',
    'time-travel-bookmark': 'pass',
    'rollback-or-disablement': 'pass',
    'zero-idle-inventory': 'pass',
    'prefix-cleanup-verified': 'pass',
  };
  const evidence = { mode: 'full-v0', sha: env.GITHUB_SHA, runId: '182', attempt: '3', results };
  const name = (proof = evidence, status = 'success', context = env) => qualificationReceiptName(context, proof, status, cwd);
  assert.equal(name(), `drive-staging-qualification-${env.GITHUB_SHA}-attempt-3`);
  for (const override of [{ mode: 'preview' }, { mode: 'fixture' }, { sha: ancestor }, { runId: '181' }, { attempt: '2' }]) {
    assert.throws(() => name({ ...evidence, ...override }), /full-v0 evidence/);
  }
  for (const status of ['failure', 'cancelled', 'skipped', 'neutral', null]) {
    assert.throws(() => name(evidence, status), /successful full-v0/);
  }
  for (const attempt of ['0', '03', '3\n', 3]) {
    assert.throws(() => name({ ...evidence, attempt }, 'success', { ...env, GITHUB_RUN_ATTEMPT: attempt }), /attempt/);
  }
  for (const caseName of Object.keys(results)) {
    const { [caseName]: _, ...incomplete } = results;
    assert.throws(() => name({ ...evidence, results: incomplete }), /must pass/, `missing ${caseName}`);
  }
  for (const outcome of ['fail', 'skip', 'cancelled', 'unverified', true]) {
    assert.throws(() => name({ ...evidence, results: { ...results, 'prefix-cleanup-verified': outcome } }), /must pass/);
  }
  assert.throws(() => name({ ...evidence, results: { ...results, 'passkey-positive': 'skip' } }), /must pass/);
  assert.throws(() => name({ ...evidence, results: { ...results, 'fixture-only': 'pass' } }), /must pass/);
});

test('the staged workflow has no producer or provider path', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-qualification.yml', import.meta.url), 'utf8');
  const gate = "github.repository == 'TogetherWeOwn/qerith' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'";
  assert.equal(workflow.split('\n\n')[1], `on:
  workflow_dispatch:
    inputs:
      tested_sha:
        description: Lowercase 40-hex SHA of the dispatch head on main
        required: true
        type: string`);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(workflow, /^concurrency:/m);
  const [source, qualification] = workflow.split('\n  qualification:\n');
  assert.ok(source.includes(`  source:\n    if: ${gate}\n`));
  assert.doesNotMatch(source, /concurrency:/);
  assert.ok(qualification.startsWith(`    needs: source\n    if: success() && !cancelled() && needs.source.result == 'success' && ${gate}\n    concurrency:\n      group: drive-staging-lifecycle\n      cancel-in-progress: false\n    environment: staging\n`));
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}\n +fetch-depth: 0\n +persist-credentials: false/);
  assert.match(workflow, /TESTED_SHA: \$\{\{ inputs\.tested_sha \}\}\n +run: timeout .* node apps\/drive\/scripts\/staging-qualification\.mjs/);
  assert.equal(workflow.match(/timeout-minutes: 5/g)?.length, 2);
  assert.doesNotMatch(workflow, /staging-qualification-migrations|upload-artifact|secrets\.|continue-on-error|always\(\)/);
  assert.match(workflow, /    needs: source\n[\s\S]*\n          exit 1\n$/);
});
