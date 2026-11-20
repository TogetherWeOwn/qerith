import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertDispatch, qualificationReceiptName } from './staging-qualification.mjs';
import { runQualificationLifecycle } from './staging-qualification-lifecycle.mjs';
import { cleanQualificationR2 } from './staging-qualification-cleanup.mjs';

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

function lifecycle(t, failure, controller = new AbortController()) {
  const { cwd, env } = history(t);
  Object.assign(env, { GITHUB_ACTIONS: 'true', GITHUB_JOB: 'qualification',
    GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/drive-staging-qualification.yml@refs/heads/main' });
  const events = [];
  const prefix = 'drive-qualification/full-v0/182/3/';
  const failures = [].concat(failure);
  const step = name => {
    events.push(name);
    return !failures.includes(name);
  };
  const candidate = { version: 'candidate' };
  const ops = {
    assertFullV0: () => step('full-v0'),
    inventory({ phase, sha }, signal) {
      assert.equal(sha, env.TESTED_SHA);
      assert.equal(signal.aborted, false);
      if (failure === 'cancel-after-restore' && phase === 'after') controller.abort();
      return step(`inventory-${phase}`);
    },
    async recordRecovery({ kind, ...data }) {
      await Promise.resolve();
      assert.equal(data.prefix, prefix);
      assert.equal(kind === 'd1' ? data.bookmark : data.previousVersion, kind === 'd1' ? 'bookmark' : 'baseline');
      return step(`record-${kind}`);
    },
    async exercise({ version, prefix: keyPrefix }, signal) {
      assert.equal(version, 'candidate');
      assert.equal(keyPrefix, prefix);
      step('exercise');
      if (failure === 'cancel') controller.abort();
      await Promise.resolve();
      step('exercise-settled');
      signal.throwIfAborted();
      if (failure === 'exercise') throw new Error('Case failed');
      return { 'passkey-positive': 'pass' };
    },
    cleanup({ prefix: keyPrefix, version }, signal) {
      assert.equal(keyPrefix, prefix);
      assert.equal(version, 'candidate');
      assert.equal(signal.aborted, false);
      return step('cleanup');
    },
  };
  const adapters = {
    upload() {
      if (!step('upload')) throw new Error('Reconcile staging before retrying');
      return candidate;
    },
    async migrate({ recordRecovery }) {
      await recordRecovery({ bookmark: 'bookmark' });
      step('migrate');
      return { bookmark: 'bookmark' };
    },
    probe: () => step('probe'),
    async worker({ upload, recordRecovery, probe, exercise, cleanup }, _env, _cwd, signal) {
      assert.equal(upload, candidate);
      await recordRecovery({ previousVersion: 'baseline' });
      step('activate');
      try {
        if (!probe()) throw new Error('Readiness failed');
        try {
          return { cases: await exercise(candidate, signal), restoredDeployment: 'restored' };
        } finally {
          if (await cleanup(candidate, new AbortController().signal) !== true) {
            throw new Error('Qualification prefix cleanup is unverified.');
          }
        }
      } finally {
        if (!step('restore')) throw new Error('Worker rollback is unverified; reconcile before retrying.');
      }
    },
  };
  return { events, run: () => runQualificationLifecycle(ops, env, cwd, controller.signal, adapters) };
}

const successOrder = ['full-v0', 'inventory-before', 'upload', 'record-d1', 'migrate', 'record-worker',
  'activate', 'probe', 'exercise', 'exercise-settled', 'cleanup', 'restore', 'inventory-after'];

test('qualification lifecycle keeps cleanup inside the candidate and inventories after restore', async t => {
  const { run, events } = lifecycle(t);
  assert.deepEqual(await run(), { migrations: { bookmark: 'bookmark' },
    deployment: { cases: { 'passkey-positive': 'pass' }, restoredDeployment: 'restored' } });
  assert.deepEqual(events, successOrder);
});

test('qualification lifecycle rejects missing admission, a stale baseline and unrecorded recovery', async t => {
  for (const [failure, error, finalInventory] of [
    ['full-v0', /admission is unverified/, false],
    ['inventory-before', /inventory is unverified/, false],
    ['upload', /Reconcile staging before retrying/, true],
    ['record-d1', /recovery record is unverified/, true],
    ['record-worker', /recovery record is unverified/, true],
  ]) {
    const { run, events } = lifecycle(t, failure);
    await assert.rejects(run(), error);
    assert.deepEqual(events, [...successOrder.slice(0, successOrder.indexOf(failure) + 1),
      ...(finalInventory ? ['inventory-after'] : [])]);
  }
});

test('qualification failures and cancellation suppress the result without skipping recovery', async t => {
  for (const [failure, error] of [
    ['exercise', /Case failed/], ['cancel', { name: 'AbortError' }], ['cleanup', /prefix cleanup is unverified/],
    ['inventory-after', /inventory is unverified/], ['cancel-after-restore', { name: 'AbortError' }],
  ]) {
    const { run, events } = lifecycle(t, failure);
    await assert.rejects(run(), error);
    assert.deepEqual(events, successOrder);
  }
  const { run, events } = lifecycle(t, 'probe');
  await assert.rejects(run(), /Readiness failed/);
  assert.deepEqual(events, [...successOrder.slice(0, 8), 'restore', 'inventory-after']);
});

test('final inventory failure preserves Worker rollback reconciliation', async t => {
  const { run, events } = lifecycle(t, ['restore', 'inventory-after']);
  await assert.rejects(run(), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /rollback is unverified; reconcile/);
    assert.match(error.errors[1].message, /inventory is unverified \(after\)/);
    return true;
  });
  assert.deepEqual(events, successOrder);
});

const r2Attempt = { runId: '182', attempt: '3', prefix: 'drive-qualification/full-v0/182/3/' };
const r2Key = `${r2Attempt.prefix}fixture`;

function r2Fixture({ pending = { uploads: [{ key: r2Key, uploadId: 'fixture-upload' }] },
  objects = { keys: [r2Key] }, afterUploads = { uploads: [] }, afterObjects = { keys: [] }, status = 204 } = {}) {
  const trace = [];
  const list = (kind, first, after) => async ({ prefix, verifyScope, signal }) => {
    assert.equal(prefix, r2Attempt.prefix);
    assert.equal(verifyScope, true);
    assert.equal(signal.aborted, false);
    const seen = trace.includes(kind);
    trace.push(kind);
    return seen ? after : first;
  };
  return { trace, io: { listing: { uploads: list('uploads', pending, afterUploads), objects: list('objects', objects, afterObjects) },
    request: async ({ method, key, query, signal }) => {
      assert.equal(method, 'DELETE');
      assert.equal(signal.aborted, false);
      trace.push([key, query]);
      return { status };
    } } };
}

test('R2 cleanup validates both lists before deleting and proves the exact prefix empty', async () => {
  const { trace, io } = r2Fixture();
  assert.equal(await cleanQualificationR2(r2Attempt, undefined, io), true);
  assert.deepEqual(trace, ['uploads', 'objects', [r2Key, { uploadId: 'fixture-upload' }], [r2Key, undefined], 'uploads', 'objects']);
});

test('R2 cleanup refuses unsafe or partial snapshots before the first mutation', async () => {
  const invalid = [
    { objects: { keys: [r2Key, r2Key.replace('/182/3/', '/182/30/')] } },
    { objects: { keys: [`${r2Attempt.prefix}../sibling`] } },
    { objects: { keys: [r2Key, r2Key] } },
    { objects: { keys: [], nextContinuationToken: 'partial' } },
    { pending: { uploads: [], nextKeyMarker: r2Key, nextUploadIdMarker: 'partial' } },
    { pending: { uploads: [{ key: r2Key, uploadId: '' }] } },
    { objects: { keys: Array.from({ length: 100 }, (_, i) => `${r2Key}-${i}`) } },
  ];
  for (const options of invalid) {
    const { trace, io } = r2Fixture(options);
    await assert.rejects(cleanQualificationR2(r2Attempt, undefined, io), /cleanup is unverified/);
    assert.deepEqual(trace, ['uploads', 'objects']);
  }
  const { trace, io } = r2Fixture();
  await assert.rejects(cleanQualificationR2({ ...r2Attempt, prefix: 'drive-qualification/' }, undefined, io), /cleanup is unverified/);
  await assert.rejects(cleanQualificationR2({ ...r2Attempt, attempt: '../3' }, undefined, io), /Invalid qualification run or attempt/);
  assert.deepEqual(trace, []);
});

test('R2 cleanup withholds success on leftovers, failed deletion or cancellation', async () => {
  for (const options of [{ afterObjects: { keys: [r2Key] } },
    { afterUploads: { uploads: [{ key: r2Key, uploadId: 'late-upload' }] } }, { status: 403 }]) {
    await assert.rejects(cleanQualificationR2(r2Attempt, undefined, r2Fixture(options).io), /cleanup is unverified/);
  }
  const controller = new AbortController();
  const { trace, io } = r2Fixture();
  io.request = async () => { trace.push('request settled'); controller.abort(); return { status: 204 }; };
  await assert.rejects(cleanQualificationR2(r2Attempt, controller.signal, io), /cleanup is unverified/);
  assert.deepEqual(trace, ['uploads', 'objects', 'request settled']);
});

test('the staged workflow has no producer or provider path', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-qualification.yml', import.meta.url), 'utf8');
  const gate = "github.repository == 'TogetherWeOwn/qerith' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'";
  const [name, trigger, permissions, ...jobs] = workflow.trimEnd().split('\n\n');
  assert.equal(trigger, `on:
  workflow_dispatch:
    inputs:
      tested_sha:
        description: Lowercase 40-hex SHA of the dispatch head on main
        required: true
        type: string`);
  assert.equal(permissions, 'permissions:\n  contents: read');
  assert.equal(name, 'name: Drive staging qualification');
  const jobBlocks = jobs.join('\n\n').split('\n\n  qualification:\n');
  assert.equal(jobBlocks.length, 2);
  const splitSteps = job => {
    const sections = job.split('\n    steps:\n');
    assert.equal(sections.length, 2);
    return sections;
  };
  const [sourceHeader, sourceSteps] = splitSteps(jobBlocks[0]);
  assert.equal(sourceHeader, `jobs:
  # Validate before entering the shared queue: even non-preempting jobs can replace pending jobs.
  source:
    if: ${gate}
    runs-on: ubuntu-latest
    timeout-minutes: 5`);
  const [qualificationHeader, qualificationSteps] = splitSteps(jobBlocks[1]);
  assert.equal(qualificationHeader, `    needs: source
    if: success() && !cancelled() && needs.source.result == 'success' && ${gate}
    concurrency:
      group: drive-staging-lifecycle
      cancel-in-progress: false
    environment: staging
    runs-on: ubuntu-latest
    timeout-minutes: 5`);
  assert.equal(sourceSteps, `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false
      - name: Verify exact dispatch source before staging approval
        env:
          TESTED_SHA: \${{ inputs.tested_sha }}
        run: timeout --signal=TERM --kill-after=5s 30s node apps/drive/scripts/staging-qualification.mjs`);
  assert.equal(qualificationSteps, `      - name: Fail closed until the live runner and cleanup are reviewed
        run: |
          printf '%s\\n' 'Full-v0 staging qualification is not wired; no receipt can be issued.' >&2
          exit 1`);
});
