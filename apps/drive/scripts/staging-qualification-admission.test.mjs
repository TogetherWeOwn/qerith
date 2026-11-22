import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempDisposableSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { admittedAppSettings, assertFullV0 } from './staging-qualification-admission.mjs';
import { runQualificationLifecycle } from './staging-qualification-lifecycle.mjs';
import { candidateAppSettings, fakeQualificationAdmission } from './fixtures/qualification-admission.mjs';

const rejection = { message: 'Reviewed full-v0 admission is unverified.' };
const otherSha = 'a'.repeat(40);

function fixture(t) {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'drive-admission-'));
  t.after(() => dir.remove());
  const cwd = dir.path;
  const file = join(cwd, 'source.txt');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Drive', '-c', 'user.email=drive@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main', '--template=');
  writeFileSync(file, 'synthetic source');
  git('add', 'source.txt');
  git('commit', '-qm', 'candidate');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const scope = { sha, runId: '18', attempt: '2' };
  const env = { TESTED_SHA: sha, GITHUB_SHA: sha, GITHUB_REPOSITORY: 'TogetherWeOwn/qerith', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTIONS: 'true', GITHUB_JOB: 'qualification',
    GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/drive-staging-qualification.yml@refs/heads/main',
    GITHUB_WORKFLOW_SHA: sha, GITHUB_RUN_ID: scope.runId, GITHUB_RUN_ATTEMPT: scope.attempt };
  return { cwd, env, file, git, scope };
}

test('exact reviewed CI and fixture claims admit immutable attempt settings', async t => {
  const { cwd, env, scope } = fixture(t);
  const signal = new AbortController().signal;
  const evidence = fakeQualificationAdmission(scope);
  const admission = await assertFullV0(env, cwd, (request, active) => {
    assert.equal(active, signal);
    assert.ok(Object.isFrozen(request));
    assert.deepEqual(request, { ...scope, prefix: 'drive-qualification/full-v0/18/2/' });
    return evidence;
  }, signal);
  evidence.review[0].settings.DRIVE_SIGN_IN_FIXTURE = '1';
  assert.deepEqual(admission, scope);
  assert.ok(Object.isFrozen(admission));
  const settings = admittedAppSettings(admission, scope, cwd);
  assert.ok(Object.isFrozen(settings));
  assert.deepEqual(settings, candidateAppSettings);
  for (const invalid of [undefined, true, { ...admission }]) {
    assert.throws(() => admittedAppSettings(invalid, scope, cwd), rejection);
  }
  for (const overrides of [{ sha: otherSha }, { runId: '17' }, { attempt: '1' }]) {
    assert.throws(() => admittedAppSettings(admission, { ...scope, ...overrides }, cwd), rejection);
  }
});

test('admission rejects the wrong dispatch source and a changed checkout', async t => {
  const { cwd, env, file } = fixture(t);
  const unused = t.mock.fn(fakeQualificationAdmission);
  for (const overrides of [
    { TESTED_SHA: undefined }, { GITHUB_SHA: otherSha }, { GITHUB_WORKFLOW_SHA: otherSha },
    { GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/ci.yml@refs/heads/main' },
    { GITHUB_SHA: otherSha, TESTED_SHA: otherSha },
  ]) {
    await assert.rejects(assertFullV0({ ...env, ...overrides }, cwd, unused), rejection);
  }
  assert.equal(unused.mock.callCount(), 0);
  await assert.rejects(assertFullV0(env, cwd, scope => {
    writeFileSync(file, 'changed during admission');
    return fakeQualificationAdmission(scope);
  }), rejection);
  await assert.rejects(assertFullV0(env, cwd, unused), rejection);
  assert.equal(unused.mock.callCount(), 0);
});

test('admission fails closed on inexact review, workflow, artifact or fixture evidence', async t => {
  const { cwd, env, scope } = fixture(t);
  const evidence = () => fakeQualificationAdmission(scope);
  for (const invalid of [undefined, null, true, { passed: true }, { review: true, browser: { success: true } }]) {
    await assert.rejects(assertFullV0(env, cwd, () => invalid), rejection);
  }
  for (const [key, value] of [
    ['sha', otherSha], ['repository', 'another/repo'], ['ref', 'refs/heads/other'], ['workflow', 'other.yml'],
    ['role', 'general'], ['reviewerId', '1'], ['verdict', 'BLOCK'], ['policy', 'older-policy'],
  ]) {
    const data = evidence();
    data.review[1][key] = value;
    await assert.rejects(assertFullV0(env, cwd, () => data), rejection, `review ${key}`);
  }
  for (const key of Object.keys(candidateAppSettings)) {
    const data = evidence();
    delete data.review[0].settings[key];
    await assert.rejects(assertFullV0(env, cwd, () => data), rejection, `missing reviewed ${key}`);
    data.review[0].settings[key] = 'unexpected';
    await assert.rejects(assertFullV0(env, cwd, () => data), rejection, `wrong reviewed ${key}`);
  }
  for (const [section, fields] of Object.entries({
    run: { sha: otherSha, runId: '0', attempt: '02', latestAttempt: '3', event: 'pull_request', ref: 'refs/heads/other',
      repository: 'another/repo', headRepository: 'fork/qerith', workflow: '.github/workflows/other.yml', workflowSha: otherSha,
      status: 'in_progress', conclusion: 'failure' },
    artifact: { sha: otherSha, runId: '100', attempt: '1', name: 'drive-browser-capture', id: '202', digest: 'unverified',
      archiveDigest: `sha256:${'b'.repeat(64)}`, expired: true },
    provenance: { requestedHead: otherSha, testedCheckout: otherSha, integrationSnapshot: otherSha, policy: otherSha,
      base: otherSha, snapshotBase: otherSha, mode: 'legacy-integration-fixture', workflow: 'other', runId: '100',
      runAttempt: '1', runUrl: 'https://github.com/another/repo/actions/runs/101' },
  })) {
    for (const [key, value] of Object.entries(fields)) {
      const data = evidence();
      data.browser[section][key] = value;
      await assert.rejects(assertFullV0(env, cwd, () => data), rejection, `${section} ${key}`);
    }
  }
  for (const name of Object.keys(evidence().browser.checks)) {
    const data = evidence();
    data.browser.checks[name].attempt = '1';
    await assert.rejects(assertFullV0(env, cwd, () => data), rejection, name);
    const missing = evidence();
    delete missing.browser.checks[name];
    await assert.rejects(assertFullV0(env, cwd, () => missing), rejection, `missing ${name}`);
  }
  const wrongJob = evidence();
  wrongJob.browser.checks['drive browser fixture capture'].steps['Exercise registered generated fixtures in Chromium with local D1'] = 'skipped';
  await assert.rejects(assertFullV0(env, cwd, () => wrongJob), rejection, 'skipped generated fixtures');
  const wrongArtifact = evidence();
  wrongArtifact.browser.checks['drive browser registry coverage'].artifactId = '202';
  await assert.rejects(assertFullV0(env, cwd, () => wrongArtifact), rejection, 'coverage verified a different artifact');
  for (const name of Object.keys(evidence().browser.fixtures)) {
    const data = evidence();
    data.browser.fixtures[name] = { passed: true };
    await assert.rejects(assertFullV0(env, cwd, () => data), rejection, name);
  }
});

test('untrusted or cancelled admission stops before inventory or provider operations', async t => {
  const { cwd, env } = fixture(t);
  const controller = new AbortController();
  const unused = t.mock.fn();
  const stages = { upload: unused, migrate: unused, worker: unused, probe: unused };
  const run = (readAdmissionEvidence, signal) => runQualificationLifecycle({
    readAdmissionEvidence, recordRecovery: unused, inventory: unused, exercise: unused, cleanup: unused,
  }, env, cwd, signal, stages);
  await assert.rejects(run(() => true), rejection);
  await assert.rejects(run(scope => {
    const proof = fakeQualificationAdmission(scope);
    proof.browser.fixtures['staging-member-download.json'].deniedWithoutStorage.grantRevoked = 200;
    return proof;
  }), rejection);
  await assert.rejects(run((scope, signal) => {
    assert.equal(signal.aborted, false);
    controller.abort(new Error('fixture cancelled'));
    return fakeQualificationAdmission(scope);
  }, controller.signal), /fixture cancelled/);
  assert.equal(unused.mock.callCount(), 0);
});
