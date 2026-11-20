import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withQualificationWorker } from './staging-qualification-worker.mjs';

const id = n => `00000000-0000-4000-8000-00000000000${n}`;
const [baseline, candidate, prior, active, restored, foreign] = [1, 2, 3, 4, 5, 6].map(id);
const deployment = (id, version_id, message) => ({
  id, versions: [{ version_id, percentage: 100 }], annotations: { 'workers/message': message },
});
const json = result => Response.json({ success: true, errors: [], result });

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'drive-qualification-worker-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const app = join(cwd, 'apps/drive');
  for (const dir of ['.svelte-kit/cloudflare', 'node_modules/.bin']) mkdirSync(join(app, dir), { recursive: true });
  copyFileSync(new URL('../wrangler.staging.json', import.meta.url), join(app, 'wrangler.staging.json'));
  writeFileSync(join(app, '.svelte-kit/cloudflare/_worker.js'), 'offline fixture');
  writeFileSync(join(app, 'node_modules/.bin/wrangler'), 'unused fixture');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Drive', '-c', 'user.email=drive@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main', '--template=');
  git('commit', '-q', '--allow-empty', '-m', 'dispatch');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const account = '209cf7dd678adfb683947dd7874d05af';
  const env = { GITHUB_REPOSITORY: 'TogetherWeOwn/qerith', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, TESTED_SHA: sha, GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/drive-staging-qualification.yml@refs/heads/main',
    GITHUB_JOB: 'qualification', GITHUB_RUN_ID: '18', GITHUB_RUN_ATTEMPT: '2',
    CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'fake-token' };
  const tag = `${sha}-18-2`;
  const calls = [];
  const state = { current: deployment(prior, baseline), tag };
  const controller = new AbortController();
  const identity = { sha, runId: '18', attempt: '2', version: candidate };
  const options = {
    candidate,
    recordRecovery(point) {
      assert.deepEqual(point, { ...identity, previousVersion: baseline, previousDeployment: prior });
      calls.push('record');
    },
    probe(target, signal) {
      assert.deepEqual(target, identity);
      assert.ok(signal instanceof AbortSignal && !signal.aborted);
      calls.push('probe');
      return { ready: true, sha, version: candidate };
    },
    exercise(target, signal) {
      assert.deepEqual(target, identity);
      assert.ok(signal instanceof AbortSignal && !signal.aborted);
      calls.push('cases');
      return 'synthetic cases';
    },
  };
  async function request(url, { method, body, redirect, signal, headers }) {
    const prefix = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/qerith-drive-staging/`;
    assert.ok(url.startsWith(prefix));
    assert.equal(headers.authorization, 'Bearer fake-token');
    assert.equal(redirect, 'error');
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    const path = url.slice(prefix.length);
    if (method === 'GET' && path === `versions/${candidate}`) {
      calls.push('version');
      return state.versionResponse ?? json({ id: candidate, annotations: { 'workers/tag': state.tag } });
    }
    assert.equal(path, 'deployments');
    if (method === 'GET') {
      calls.push('current');
      return json({ deployments: state.current ? [state.current] : [] });
    }
    assert.equal(method, 'POST');
    assert.equal(headers['content-type'], 'application/json');
    const isActivation = JSON.parse(body).versions[0].version_id === candidate;
    const version = isActivation ? candidate : baseline;
    const message = isActivation ? tag : `restore-${tag}`;
    assert.deepEqual(JSON.parse(body), { strategy: 'percentage', versions: [{ version_id: version, percentage: 100 }],
      annotations: { 'workers/message': message } });
    const name = isActivation ? 'activate' : 'restore';
    calls.push(name);
    if (!state[`${name}Ignored`]) state.current = deployment(isActivation ? active : restored, version, message);
    if (state[`${name}Lost`]) throw new Error('untrusted diagnostic fake-token');
    return json({ id: isActivation ? active : restored });
  }
  return { calls, state, options, controller, identity,
    run: (override, fetcher = request) => withQualificationWorker(options, { ...env, ...override }, cwd, controller.signal, fetcher) };
}

test('records the rollback point, proves exact-SHA readiness, and reads back the restored version', async t => {
  const { run, calls, identity } = fixture(t);
  assert.deepEqual(await run(), { ...identity, previousVersion: baseline, restoredDeployment: restored, cases: 'synthetic cases' });
  assert.deepEqual(calls, ['current', 'version', 'record', 'current', 'activate', 'current', 'probe', 'cases', 'current', 'restore', 'current']);
});

test('refuses wrong source or target, missing or split prior traffic, and stale candidates before activation', async t => {
  const { run, calls, state, options } = fixture(t);
  const expectedTag = state.tag;
  for (const override of [{ TESTED_SHA: 'a'.repeat(40) }, { GITHUB_JOB: 'publish' }, { GITHUB_RUN_ATTEMPT: '02' },
    { GITHUB_RUN_ID: 18 }, { GITHUB_WORKFLOW_REF: 'other' }, { CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) }]) await assert.rejects(run(override));
  assert.deepEqual(calls, []);
  for (const current of [undefined, { ...deployment(prior, baseline), versions: [
    { version_id: baseline, percentage: 50 }, { version_id: foreign, percentage: 50 },
  ] }]) {
    state.current = current;
    await assert.rejects(run(), /known single-version/);
  }
  state.current = deployment(prior, baseline);
  state.tag = 'old-attempt';
  await assert.rejects(run(), /SHA and attempt/);
  state.tag = `${'a'.repeat(40)}-18-2`;
  await assert.rejects(run(), /SHA and attempt/);
  state.tag = expectedTag;
  const record = options.recordRecovery;
  options.recordRecovery = point => {
    record(point);
    state.current = deployment(foreign, baseline);
  };
  await assert.rejects(run(), /changed before activation/);
  assert.ok(!calls.includes('activate'));
});

test('rejects wrong runtime SHA or version, and restores after case failure or cooperative cancellation', async t => {
  for (const failure of ['sha', 'version', 'case', 'abort']) {
    const { run, options, calls, controller } = fixture(t);
    const probe = options.probe;
    const exercise = options.exercise;
    options.probe = (...args) => {
      const result = probe(...args);
      if (failure === 'sha') result.sha = 'a'.repeat(40);
      if (failure === 'version') result.version = foreign;
      return result;
    };
    options.exercise = (...args) => {
      exercise(...args);
      if (failure === 'case') throw new Error('case failed');
      controller.abort();
    };
    await assert.rejects(run(), failure === 'case' ? /case failed/ : failure === 'abort' ? /aborted/ : /runtime readiness/);
    assert.equal(calls.includes('cases'), failure === 'case' || failure === 'abort');
    assert.deepEqual(calls.slice(-3), ['current', 'restore', 'current']);
  }
});

test('probe and case deadlines abort and settle work before rollback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [phase, timeout] of [['probe', 30_000], ['exercise', 20 * 60_000]]) {
    const { run, options, calls } = fixture(t);
    const started = Promise.withResolvers();
    let aborted = false;
    const drained = Promise.withResolvers();
    options[phase] = async (identity, signal) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      started.resolve();
      await drained.promise;
      calls.push('settled');
      return { ...identity, ready: true };
    };
    const outcome = assert.rejects(run(), { name: 'TimeoutError' });
    await Promise.race([started.promise, outcome]);
    t.mock.timers.tick(timeout);
    try {
      assert.ok(aborted);
      assert.ok(!calls.includes('restore'));
    } finally {
      drained.resolve();
      await outcome;
    }
    assert.deepEqual(calls.slice(-4), ['settled', 'current', 'restore', 'current']);
    if (phase === 'probe') assert.ok(!calls.includes('cases'));
  }
});

test('rejects probe and case overruns even when the timer has not fired', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const [phase, timeout] of [['probe', 30_000], ['exercise', 20 * 60_000]]) {
    const { run, options, calls } = fixture(t);
    options[phase] = (identity, signal) => {
      assert.ok(!signal.aborted);
      now += timeout;
      assert.ok(!signal.aborted);
      return { ...identity, ready: true };
    };
    await assert.rejects(run(), { name: 'TimeoutError' });
    assert.deepEqual(calls.slice(-3), ['current', 'restore', 'current']);
    if (phase === 'probe') assert.ok(!calls.includes('cases'));
  }
});

test('recovers an attempt-owned ambiguous activation but never certifies it', async t => {
  const { run, state, calls } = fixture(t);
  state.activateLost = true;
  await assert.rejects(run(), { message: 'Bounded staging Worker API call failed.' });
  assert.deepEqual(calls.slice(-4), ['activate', 'current', 'restore', 'current']);
});

test('does not overwrite a different deployment or report an unverified rollback as success', async t => {
  for (const failure of ['superseded', 'late-activation', 'restore-ignored', 'restore-lost']) {
    const { run, state, options, calls } = fixture(t);
    if (failure === 'superseded') options.exercise = () => { state.current = deployment(foreign, candidate); };
    if (failure === 'late-activation') state.activateIgnored = state.activateLost = true;
    if (failure === 'restore-ignored') state.restoreIgnored = true;
    if (failure === 'restore-lost') state.restoreLost = true;
    await assert.rejects(run(), /rollback is unverified/);
    assert.equal(calls.includes('restore'), failure.startsWith('restore'));
  }
});

test('rejects oversized, malformed or failed provider responses without mutation or diagnostic leaks', async t => {
  for (const response of [new Response('fake-token', { status: 403 }), new Response('x'.repeat(65_537)),
    new Response('fake-token'), Response.json({ success: false, result: {} })]) {
    const { run, state, calls } = fixture(t);
    state.versionResponse = response;
    await assert.rejects(run(), { message: 'Bounded staging Worker API call failed.' });
    assert.deepEqual(calls, ['current', 'version']);
  }
});
