import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowsQualificationTraffic, qualificationReadiness, readinessHeaders, readinessPath, stagingOrigin } from '../src/lib/server/qualification-readiness.ts';
import { inspectQualificationWorker, probeQualificationWorker, recoverQualificationWorker,
  uploadQualificationWorker, withQualificationWorker } from './staging-qualification-worker.mjs';
import { assertFullV0 } from './staging-qualification-admission.mjs';
import { candidateAppSettings, fakeQualificationAdmission } from './fixtures/qualification-admission.mjs';

const id = n => `00000000-0000-4000-8000-00000000000${n}`;
const [baseline, candidate, prior, active, restored, foreign] = [1, 2, 3, 4, 5, 6].map(id);
const deployment = (id, version_id, message) => ({
  id, versions: [{ version_id, percentage: 100 }], annotations: { 'workers/message': message },
});
const json = result => Response.json({ success: true, errors: [], result });
const sha = 'a'.repeat(40);
const readinessEnv = { DRIVE_ORIGIN: stagingOrigin, DRIVE_QUALIFICATION_SHA: sha, DRIVE_QUALIFICATION_VERSION: { id: candidate } };
const probeUrl = stagingOrigin + readinessPath;
const now = 1_800_000_000_000;
const expiresAt = String(now + 25 * 60_000);
const expiryBinding = 'DRIVE_QUALIFICATION_EXPIRES_AT';
const attemptVars = { DRIVE_QUALIFICATION_RUN_ID: '18', DRIVE_QUALIFICATION_RUN_ATTEMPT: '2' };

test('candidate traffic fails closed at its absolute deadline and with partial identity', () => {
  const env = { ...readinessEnv, [expiryBinding]: expiresAt };
  assert.equal(allowsQualificationTraffic({ DRIVE_ORIGIN: stagingOrigin }, Number(expiresAt)), true);
  assert.equal(allowsQualificationTraffic(env, Number(expiresAt) - 1), true);
  for (const time of [now - 1, Number(expiresAt), Number(expiresAt) + 1]) {
    assert.equal(allowsQualificationTraffic(env, time), false);
  }
  for (const override of [{ [expiryBinding]: undefined }, { [expiryBinding]: ` ${expiresAt}` },
    { [expiryBinding]: `${expiresAt}\n` }, { [expiryBinding]: Number(expiresAt) },
    { DRIVE_QUALIFICATION_VERSION: undefined }, { DRIVE_QUALIFICATION_SHA: undefined },
    { DRIVE_ORIGIN: 'https://drive.example.test' }, { DRIVE_SIGN_IN_FIXTURE: '1' }]) {
    assert.equal(allowsQualificationTraffic({ ...env, ...override }, now), false);
  }
});

test('readiness stays off without candidate bindings and never admits app requests', () => {
  const headers = { [readinessHeaders.nonce]: 'b'.repeat(32), [readinessHeaders.sha]: 'f'.repeat(40) };
  const head = new Request(probeUrl, { method: 'HEAD', headers });
  const check = (env, request = head, ready = true, status = 404) => {
    const result = qualificationReadiness(request, env, ready);
    assert.equal(result.status, status);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    assert.equal(result.body, null);
    for (const name of Object.values(readinessHeaders)) assert.equal(result.headers.get(name), null);
  };
  for (const env of [{ DRIVE_ORIGIN: stagingOrigin }, { ...readinessEnv, DRIVE_SIGN_IN_FIXTURE: '1' },
    { ...readinessEnv, DRIVE_ORIGIN: 'https://drive.example.test' }, { ...readinessEnv, DRIVE_ORIGIN: 'disabled' },
    { ...readinessEnv, DRIVE_QUALIFICATION_SHA: 'HEAD' }, { ...readinessEnv, DRIVE_QUALIFICATION_VERSION: { id: 'latest' } }]) check(env);
  for (const input of [new Request(probeUrl, { headers }), new Request(probeUrl, { method: 'HEAD' }),
    new Request(stagingOrigin, { method: 'HEAD', headers }), new Request(probeUrl + '?', { method: 'HEAD', headers }),
    new Request('https://other.example.test' + readinessPath, { method: 'HEAD', headers }),
    new Request(probeUrl, { method: 'HEAD', headers: { ...headers, origin: 'https://other.example.test' } })]) check(readinessEnv, input);
  check(readinessEnv, head, false, 503);
  assert.equal(qualificationReadiness(head, readinessEnv, true).headers.get(readinessHeaders.sha), sha);
});

test('the readiness probe requires fresh exact-SHA evidence from the responding Worker', async () => {
  const identity = { sha, version: candidate };
  const controller = new AbortController();
  let previous;
  const request = async (url, init) => {
    assert.equal(url, probeUrl);
    assert.deepEqual([init.method, init.redirect, init.cache, init.credentials], ['HEAD', 'error', 'no-store', 'omit']);
    assert.deepEqual(Object.keys(init.headers), [readinessHeaders.nonce]);
    assert.ok(init.signal instanceof AbortSignal && !init.signal.aborted);
    return qualificationReadiness(new Request(url, init), readinessEnv, true);
  };
  assert.deepEqual(await probeQualificationWorker(identity, controller.signal, async (...args) => {
    previous = await request(...args);
    return previous;
  }), { ...identity, ready: true });
  await assert.rejects(probeQualificationWorker(identity, controller.signal, async () => previous), /fresh exact-SHA/);
  for (const bad of [{ sha: 'f'.repeat(40) }, { version: foreign }]) {
    await assert.rejects(probeQualificationWorker({ ...identity, ...bad }, controller.signal, request), /fresh exact-SHA/);
  }
  for (const status of [200, 302, 404, 503]) {
    await assert.rejects(probeQualificationWorker(identity, controller.signal, async (...args) =>
      new Response(null, { status, headers: (await request(...args)).headers })), /fresh exact-SHA/);
  }
  await assert.rejects(probeQualificationWorker(identity, controller.signal, async (...args) => {
    const response = await request(...args);
    response.headers.set('cache-control', 'public');
    return response;
  }), /fresh exact-SHA/);
  await assert.rejects(probeQualificationWorker(identity, controller.signal, async (...args) => {
    const response = await request(...args);
    controller.abort();
    return response;
  }), /fresh exact-SHA/);
});

test('the readiness probe rejects exact evidence at or after its deadline before the abort timer fires', async t => {
  let now = 1_000;
  t.mock.method(performance, 'now', () => now);
  let requestSignal;
  const identity = { sha, version: candidate };
  const probeAfter = elapsed => probeQualificationWorker(identity, undefined, async (url, init) => {
    requestSignal = init.signal;
    const response = qualificationReadiness(new Request(url, init), readinessEnv, true);
    now += elapsed;
    return response;
  });
  assert.deepEqual(await probeAfter(9_999), { ...identity, ready: true });
  for (const elapsed of [10_000, 10_074]) {
    await assert.rejects(probeAfter(elapsed), /fresh exact-SHA/);
    assert.equal(requestSignal.aborted, false);
  }
});

const storageEnv = { QERITH_S3_ENDPOINT: 'https://storage.example.test', QERITH_S3_BUCKET: 'fixture',
  QERITH_S3_REGION: 'auto', QERITH_S3_STORAGE_EPOCH: 'epoch', QERITH_S3_ACCESS_KEY_ID: 'fake-access',
  QERITH_S3_SECRET_ACCESS_KEY: 'fake-storage-secret' };
const storageConfigId = JSON.stringify([storageEnv.QERITH_S3_ENDPOINT, storageEnv.QERITH_S3_BUCKET, storageEnv.QERITH_S3_STORAGE_EPOCH]);
const evidence = { version: 1, storageConfigId, region: 'auto', sourceSha: sha, runId: '42', runAttempt: 1, completionTimeoutMs: 3000 };
const storageVars = { DRIVE_S3_ENDPOINT: storageEnv.QERITH_S3_ENDPOINT, DRIVE_S3_BUCKET: storageEnv.QERITH_S3_BUCKET,
  DRIVE_S3_REGION: 'auto', DRIVE_S3_STORAGE_EPOCH: 'epoch', DRIVE_S3_QUALIFICATION: JSON.stringify(evidence) };
const secretBindings = ['DRIVE_OWNER_ENROLLMENT', 'DRIVE_S3_ACCESS_KEY_ID', 'DRIVE_S3_SECRET_ACCESS_KEY'];
const varsToBindings = vars => Object.entries(vars).map(([name, text]) => ({ name, type: 'plain_text', text }));

function fixture(t, upload = false) {
  t.mock.method(Date, 'now', () => now);
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
  git('add', 'apps/drive/wrangler.staging.json');
  if (upload) {
    mkdirSync(join(app, 'scripts'));
    const receipt = { ...evidence, passed: true, failures: [], cleanup: 'verified', scope: { policySha256: 'b'.repeat(64),
      identitySha256: createHash('sha256').update(JSON.stringify([storageConfigId, 'auto', 'fake-access'])).digest('hex') } };
    writeFileSync(join(app, 'scripts/staging-storage-qualification.json'), JSON.stringify(receipt));
    git('add', 'apps/drive/scripts/staging-storage-qualification.json');
    // Qualification reads the reviewed Git blob, never the working-copy proof.
    writeFileSync(join(app, 'scripts/staging-storage-qualification.json'), 'unreviewed');
  }
  git('commit', '-q', '--allow-empty', '-m', 'dispatch');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const account = '209cf7dd678adfb683947dd7874d05af';
  const env = { GITHUB_REPOSITORY: 'TogetherWeOwn/qerith', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, TESTED_SHA: sha, GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/drive-staging-qualification.yml@refs/heads/main',
    GITHUB_JOB: 'qualification', GITHUB_RUN_ID: '18', GITHUB_RUN_ATTEMPT: '2',
    CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: 'fake-token' };
  const tag = `${sha}-18-2`;
  const calls = [];
  const { d1_databases: [db] } = JSON.parse(readFileSync(join(app, 'wrangler.staging.json'), 'utf8'));
  const state = { current: deployment(prior, baseline), tag, candidateBindings: [
    { name: 'DB', type: 'd1', id: db.database_id }, { name: 'ASSETS', type: 'assets' },
    ...varsToBindings({ DRIVE_QUALIFICATION_SHA: sha, [expiryBinding]: expiresAt, ...attemptVars }),
    { name: 'DRIVE_QUALIFICATION_VERSION', type: 'version_metadata' },
  ] };
  const controller = new AbortController();
  const identity = { sha, runId: '18', attempt: '2', version: candidate };
  const options = {
    upload: { version: candidate, expiresAt, previousVersion: baseline, previousDeployment: prior },
    recordRecovery(point) {
      assert.deepEqual(point, { ...identity, expiresAt, previousVersion: baseline, previousDeployment: prior });
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
    cleanup: () => true,
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
      return state.versionResponse ?? json({ id: candidate, annotations: { 'workers/tag': state.tag },
        resources: { bindings: state.candidateBindings } });
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
  return { calls, state, options, controller, identity, cwd, app, env, git, request,
    run: (override, fetcher = request) => withQualificationWorker(options, { ...env, ...override }, cwd, controller.signal, fetcher) };
}

function inventoryFixture(t) {
  const { app, controller, cwd, env } = fixture(t);
  const config = JSON.parse(readFileSync(join(app, 'wrangler.staging.json'), 'utf8'));
  writeFileSync(join(app, 'wrangler.staging.json'), 'not the tested configuration');
  const bindings = [{ name: 'DB', type: 'd1', id: config.d1_databases[0].database_id },
    { name: 'ASSETS', type: 'assets' }, { name: 'SECRET', type: 'secret_text' }];
  const replies = {
    scripts: [{ id: config.name }],
    deployments: { deployments: [deployment(prior, baseline)] },
    [`versions/${baseline}`]: { id: baseline, resources: { bindings } },
    schedules: { schedules: [] },
  };
  const calls = [];
  const state = {};
  const inspect = (override = {}) => inspectQualificationWorker({ ...env, ...override }, cwd, controller.signal,
    async (url, { method, body, redirect, headers, signal }) => {
      assert.equal(method, 'GET');
      assert.equal(body, undefined);
      assert.equal(redirect, 'error');
      assert.equal(headers.authorization, 'Bearer fake-token');
      assert.equal(signal.aborted, false);
      const scripts = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts`;
      const prefix = `${scripts}/${config.name}/`;
      assert.ok(url === scripts || url.startsWith(prefix));
      const path = url === scripts ? 'scripts' : url.slice(prefix.length);
      calls.push(path);
      assert.ok(Object.hasOwn(replies, path));
      if (calls.length === 5 && state.changed) return json({ deployments: [deployment(active, baseline)] });
      if (calls.length === 5 && state.cancelled) controller.abort();
      return replies[path] instanceof Response ? replies[path] : json(replies[path]);
    });
  return { bindings, calls, inspect, replies, state };
}

test('Worker inventory uses the committed config for an unfiltered roster and pinned readbacks', async t => {
  const { calls, inspect } = inventoryFixture(t);
  for (const override of [{ TESTED_SHA: sha }, { GITHUB_JOB: 'preview' }, { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }]) {
    await assert.rejects(inspect(override), /Cannot verify staging Worker cron and resource bindings/);
    assert.deepEqual(calls, []);
  }
  assert.deepEqual(await inspect(), { version: baseline, deployment: prior, schedules: 0, resources: ['DB', 'ASSETS'],
    attemptRestore: false });
  assert.deepEqual(calls, ['scripts', 'deployments', `versions/${baseline}`, 'schedules', 'deployments']);
});

test('Worker inventory refuses incomplete or invalid account rosters', async t => {
  const { calls, inspect, replies } = inventoryFixture(t);
  const roster = replies.scripts;
  for (const reply of [[], [null], [{ id: 'other' }], [...roster, ...roster], { scripts: roster },
    new Response('private diagnostic', { status: 403 }), json([{ ...roster[0], detail: 'a'.repeat(65_536) }]),
    Response.json({ success: true, errors: [], result: roster, result_info: { cursor: 'more' } }),
    ...[{ status: 206 }, { headers: { 'content-range': 'bytes 0-99/200' } },
      { headers: { link: '<https://example.test/>; rel="next"' } }].map(init =>
      Response.json({ success: true, errors: [], result: roster }, init)),
  ]) {
    calls.length = 0;
    replies.scripts = reply;
    await assert.rejects(inspect(), { message: 'Cannot verify staging Worker cron and resource bindings.' });
    assert.deepEqual(calls, ['scripts']);
  }
});

test('Worker inventory rejects partial schedule readbacks even with an empty result', async t => {
  for (const [name, init] of [['HTTP 206', { status: 206 }],
    ['Content-Range on HTTP 200', { headers: { 'content-range': 'bytes 0-53/108' } }]]) {
    await t.test(name, async sub => {
      const { calls, inspect, replies } = inventoryFixture(sub);
      replies.schedules = Response.json({ success: true, errors: [], result: { schedules: [] } }, init);
      await assert.rejects(inspect(), { message: 'Cannot verify staging Worker cron and resource bindings.' });
      assert.deepEqual(calls, ['scripts', 'deployments', `versions/${baseline}`, 'schedules']);
    });
  }
});

test('Worker inventory rejects cron, unknown bindings, candidates, deployment drift and cancellation', async t => {
  const { bindings, calls, inspect, replies, state } = inventoryFixture(t);
  const error = { message: 'Cannot verify staging Worker cron and resource bindings.' };
  for (const schedules of [{}, { schedules: null }, { schedules: [{ cron: '* * * * *' }] },
    new Response('private diagnostic fake-token', { status: 403 })]) {
    replies.schedules = schedules;
    calls.length = 0;
    await assert.rejects(inspect(), error);
    assert.equal(calls.at(-1), 'schedules');
  }
  replies.schedules = { schedules: [] };
  const versionPath = `versions/${baseline}`;
  for (const binding of [{ name: 'EXTRA', type: 'durable_object_namespace' }, { name: 'EXTRA', type: 'container' },
    { name: 'DRIVE_QUALIFICATION_SHA', type: 'plain_text' }, { name: 'DRIVE_QUALIFICATION_VERSION', type: 'plain_text' },
    { name: expiryBinding, type: 'plain_text', text: expiresAt }, { name: 'DB', type: 'd1', id: foreign }]) {
    replies[versionPath].resources.bindings = binding.name === 'DB' ? [binding, ...bindings.slice(1)] : [...bindings, binding];
    calls.length = 0;
    await assert.rejects(inspect(), error);
    assert.deepEqual(calls, ['scripts', 'deployments', versionPath]);
  }
  replies[versionPath].resources.bindings = bindings;
  for (const key of ['changed', 'cancelled']) {
    state.changed = false;
    state[key] = true;
    calls.length = 0;
    await assert.rejects(inspect(), error);
    assert.equal(calls.length, 5);
  }
});

function uploadFixture({ cwd, app, env }, admission) {
  const state = { current: deployment(prior, baseline), tag: `${env.GITHUB_SHA}-18-2` };
  const calls = [];
  const controller = new AbortController();
  const { name, d1_databases: [db] } = JSON.parse(readFileSync(join(app, 'wrangler.staging.json'), 'utf8'));
  const shared = [{ name: 'DB', type: 'd1', id: db.database_id }, { name: 'ASSETS', type: 'assets' },
    ...secretBindings.map(name => ({ name, type: 'secret_text' }))];
  const setup = { previews_enabled: false, tags: ['staging'], baselineBindings: [...shared, ...varsToBindings(storageVars)],
    uploadId: candidate, readbackTag: state.tag, adjust: bindings => bindings, history: [baseline] };
  const vars = { ...storageVars, DRIVE_ORIGIN: stagingOrigin, DRIVE_QUALIFICATION_SHA: env.GITHUB_SHA,
    [expiryBinding]: expiresAt, ...attemptVars, DRIVE_SIGN_IN_FIXTURE: '0', DRIVE_STAGING_INVITE_ACCEPTANCE: '0',
    DRIVE_OWNER_ENROLLMENT_RELEASE: 'disabled', ...(admission && candidateAppSettings) };
  const uploaded = [...shared, ...varsToBindings(vars), { name: 'DRIVE_QUALIFICATION_VERSION', type: 'version_metadata' }];
  async function request(url, { method, body, headers }) {
    const prefix = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/`;
    assert.ok(url.startsWith(prefix));
    assert.equal(headers.authorization, 'Bearer fake-token');
    assert.equal(method, 'GET');
    assert.equal(body, undefined);
    const path = url.slice(prefix.length);
    calls.push(path);
    if (path === `scripts/${name}/subdomain`) return json({ previews_enabled: setup.previews_enabled });
    if (path === `services/${name}`) return json({ default_environment: { script: { tags: setup.tags } } });
    if (path === `scripts/${name}/deployments`) return json({ deployments: [state.current] });
    if (path === `scripts/${name}/versions`) return json({ items: setup.history.map(id => ({ id })) });
    if (path === `scripts/${name}/versions/${baseline}`) return json({ id: baseline, resources: { bindings: setup.baselineBindings } });
    assert.equal(path, `scripts/${name}/versions/${candidate}`);
    return json({ id: candidate, annotations: { 'workers/tag': setup.readbackTag }, resources: { bindings: setup.adjust(uploaded) } });
  }
  let scratch;
  function runner(binary, args, options) {
    calls.push('upload');
    assert.equal(binary, join(app, 'node_modules/.bin/wrangler'));
    assert.deepEqual(args, ['versions', 'upload', '--config', args[3], '--env-file', args[5], '--tag', state.tag]);
    const config = JSON.parse(readFileSync(args[3], 'utf8'));
    assert.deepEqual(config.vars, vars);
    assert.deepEqual(config.version_metadata, { binding: 'DRIVE_QUALIFICATION_VERSION' });
    assert.deepEqual(config.secrets, { required: secretBindings });
    assert.equal(config.main, join(app, '.svelte-kit/cloudflare/_worker.js'));
    assert.equal(config.assets.directory, join(app, '.svelte-kit/cloudflare'));
    assert.equal(readFileSync(args[5], 'utf8'), '');
    assert.equal(statSync(args[3]).mode & 0o777, 0o600);
    assert.equal(options.env.CLOUDFLARE_API_TOKEN, 'fake-token');
    assert.doesNotMatch(JSON.stringify([config, args, options.env]), /fake-access|fake-storage-secret|unsafe-override/);
    scratch = options.env.HOME;
    const record = { type: 'version-upload', version: 1, worker_name: name, worker_name_overridden: false, version_id: setup.uploadId };
    writeFileSync(options.env.WRANGLER_OUTPUT_FILE_PATH, setup.output ?? JSON.stringify(record));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    process.nextTick(() => {
      if (setup.interleavedUpload) setup.history.unshift(foreign);
      setup.history.unshift(setup.uploadId);
      if (setup.superseded) state.current = deployment(foreign, baseline);
      if (setup.abort) controller.abort();
      child.stderr.emit('data', setup.overflow ? Buffer.alloc(65_537) : Buffer.from('untrusted diagnostic with fake-token'));
      child.emit('close', 0);
    });
    return child;
  }
  const run = override => uploadQualificationWorker({ ...env, ...storageEnv,
    WRANGLER_CI_OVERRIDE_NAME: 'unsafe-override', CLOUDFLARE_API_BASE_URL: 'unsafe-override', ...override },
    cwd, controller.signal, request, runner, admission);
  return { setup, calls, scratch: () => scratch, run };
}

test('uploads only the exact-attempt version with inherited secrets and an unchanged baseline', async t => {
  const { run, calls, scratch } = uploadFixture(fixture(t, true));
  assert.deepEqual(await run(), { version: candidate, expiresAt, previousVersion: baseline, previousDeployment: prior });
  assert.deepEqual(calls.map(path => path.split('/').at(-1)), ['subdomain', 'qerith-drive-staging', 'deployments',
    baseline, 'versions', 'upload', candidate, 'versions', 'deployments']);
  assert.ok(!existsSync(scratch()));
});

test('uploads admitted settings and verifies the immutable version readback', async t => {
  const source = fixture(t, true);
  source.git('restore', '--', 'apps/drive/scripts/staging-storage-qualification.json');
  const admission = await assertFullV0(source.env, source.cwd, fakeQualificationAdmission);
  const good = uploadFixture(source, admission);
  assert.deepEqual(await good.run({ DRIVE_SIGN_IN_FIXTURE: '1', DRIVE_STAGING_READ_GRANTS: '0' }),
    { version: candidate, expiresAt, previousVersion: baseline, previousDeployment: prior });
  const bad = uploadFixture(source, admission);
  bad.setup.adjust = bindings => bindings.filter(binding => binding.name !== 'DRIVE_STAGING_READ_GRANTS');
  await assert.rejects(bad.run(), /incompatible resource/);
  assert.ok(bad.calls.includes('upload'));

  for (const incorrect of [true, { ...admission }]) {
    const forged = uploadFixture(source, incorrect);
    await assert.rejects(forged.run(), /admission is unverified/);
    assert.deepEqual(forged.calls, []);
  }
  const wrongAttempt = uploadFixture(source, admission);
  await assert.rejects(wrongAttempt.run({ GITHUB_RUN_ATTEMPT: '3' }), /admission is unverified/);
  assert.deepEqual(wrongAttempt.calls, []);
});

test('rejects a newer undeployed version before inheriting staging secrets', async t => {
  const { setup, calls, run } = uploadFixture(fixture(t, true));
  setup.history = [foreign, baseline];
  await assert.rejects(run(), /baseline is not the latest uploaded version/);
  assert.ok(!calls.includes('upload'));
});

test('rejects an intervening upload even when the candidate binding names and deployment match', async t => {
  const { setup, calls, run } = uploadFixture(fixture(t, true));
  setup.interleavedUpload = true;
  await assert.rejects(run(), /candidate did not immediately follow the staging baseline/);
  assert.ok(calls.includes('upload'));
});

test('rejects unreviewed storage, unsafe targets and incompatible baselines before upload', async t => {
  const source = fixture(t, true);
  for (const [mutate, message, override] of [
    [() => {}, /passing qualification/, { QERITH_S3_ACCESS_KEY_ID: 'wrong-key' }],
    [c => { c.previews_enabled = true; }, /previews disabled/],
    [c => { c.tags = ['cf:service=group']; }, /ungrouped target/],
    [c => { c.baselineBindings[0].id = foreign; }, /incompatible resource/],
    [c => { c.baselineBindings = c.baselineBindings.filter(binding => binding.name !== 'DRIVE_S3_SECRET_ACCESS_KEY'); }, /storage secrets/],
  ]) {
    const { setup, calls, run } = uploadFixture(source);
    mutate(setup);
    await assert.rejects(run(override), message);
    assert.ok(!calls.includes('upload'));
  }
});

test('does not return candidates on cancellation, ambiguous output, binding drift or a changed baseline', async t => {
  const source = fixture(t, true);
  for (const [overrides, message] of [
    [{ abort: true }, /upload could not be verified/],
    [{ overflow: true }, /upload could not be verified/],
    [{ output: '{fake-token' }, /upload could not be verified/],
    [{ uploadId: baseline }, /new version ID/],
    [{ readbackTag: 'another-attempt' }, /SHA and attempt/],
    [{ adjust: bindings => bindings.filter(binding => binding.name !== expiryBinding) }, /incompatible resource/],
    [{ adjust: bindings => bindings.filter(binding => binding.name !== 'DRIVE_QUALIFICATION_RUN_ID') }, /incompatible resource/],
    [{ adjust: bindings => bindings.filter(binding => binding.name !== 'DRIVE_QUALIFICATION_VERSION') }, /unchanged staging baseline/],
    [{ adjust: bindings => bindings.filter(binding => binding.name !== 'DRIVE_OWNER_ENROLLMENT') }, /unchanged staging baseline/],
    [{ superseded: true }, /unchanged staging baseline/],
  ]) {
    const { setup, run, scratch, calls } = uploadFixture(source);
    Object.assign(setup, overrides);
    await assert.rejects(run(), error => message.test(error.message) && !error.message.includes('fake-token'));
    assert.ok(calls.includes('upload'));
    assert.ok(!existsSync(scratch()));
  }
});

test('records the rollback point, proves exact-SHA readiness, and reads back the restored version', async t => {
  const { run, calls, identity } = fixture(t);
  assert.deepEqual(await run(), { ...identity, previousVersion: baseline, restoredDeployment: restored, cases: 'synthetic cases' });
  assert.deepEqual(calls, ['current', 'version', 'record', 'current', 'activate', 'current', 'probe', 'cases', 'current', 'restore', 'current']);
});

test('activation rejects missing or mismatched attempt bindings under the correct version tag', async t => {
  const { run, calls, state } = fixture(t);
  const bindings = state.candidateBindings;
  for (const name of [...Object.keys(attemptVars), 'DRIVE_QUALIFICATION_VERSION']) {
    state.candidateBindings = bindings.filter(binding => binding.name !== name);
    await assert.rejects(run(), /incompatible resource/);
    assert.deepEqual(calls.splice(0), ['current', 'version']);
  }
  state.candidateBindings = bindings.map(binding => binding.name === 'DRIVE_QUALIFICATION_RUN_ATTEMPT'
    ? { ...binding, text: '3' } : binding);
  await assert.rejects(run(), /incompatible resource/);
  assert.deepEqual(calls, ['current', 'version']);
});

test('activation requires exact admitted settings under the correct version tag', async t => {
  const { cwd, env, run, calls, options, state } = fixture(t);
  const original = state.candidateBindings;
  const allBindings = [...original, ...varsToBindings(candidateAppSettings)];
  state.candidateBindings = allBindings;
  await assert.rejects(run(), /requires reviewed app admission/);
  assert.deepEqual(calls.splice(0), ['current', 'version']);

  options.admission = await assertFullV0(env, cwd, fakeQualificationAdmission);
  for (const name of Object.keys(candidateAppSettings)) {
    for (const bad of [null, { name, type: 'plain_text', text: 'invalid' },
      { name, type: 'json', text: candidateAppSettings[name] }]) {
      state.candidateBindings = allBindings.filter(binding => binding.name !== name).concat(bad ? [bad] : []);
      await assert.rejects(run(), /incompatible resource/);
      assert.deepEqual(calls.splice(0), ['current', 'version']);
    }
  }
  state.candidateBindings = allBindings;
  assert.equal((await run()).version, candidate);
  assert.ok(calls.includes('activate'));
});

test('refuses activation when the deadline differs or recovery recording consumes the activation window', async t => {
  const { run, calls, state, options } = fixture(t);
  const remote = state.candidateBindings.find(binding => binding.name === expiryBinding);
  remote.text = String(Number(expiresAt) - 1);
  await assert.rejects(run(), /incompatible resource/);
  assert.deepEqual(calls.splice(0), ['current', 'version']);
  remote.text = expiresAt;
  let time = now;
  t.mock.method(Date, 'now', () => time);
  const record = options.recordRecovery;
  options.recordRecovery = point => {
    record(point);
    time += 5 * 60_000;
  };
  await assert.rejects(run(), /insufficient time left to activate/);
  assert.deepEqual(calls, ['current', 'version', 'record', 'current']);
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
  state.current = deployment(foreign, baseline);
  await assert.rejects(run(), /baseline changed since candidate upload/);
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

test('runs cleanup after cancellation and preserves an unverified cleanup even when rollback fails', async t => {
  for (const restoreLost of [false, true]) {
    const { run, options, calls, controller, state } = fixture(t);
    state.restoreLost = restoreLost;
    const exercise = options.exercise;
    options.exercise = async (...args) => {
      exercise(...args);
      controller.abort();
      await Promise.resolve();
      calls.push('settled');
    };
    const cleanupFailure = new Error('Qualification prefix cleanup is unverified.');
    options.cleanup = (identity, signal) => {
      assert.equal(identity.version, candidate);
      assert.equal(identity.expiresAt, expiresAt);
      assert.equal(signal.aborted, false);
      calls.push('cleanup');
      throw cleanupFailure;
    };
    await assert.rejects(run(), error => {
      assert.ok(error instanceof AggregateError);
      const outcome = restoreLost ? error.errors[0] : error;
      assert.ok(outcome instanceof AggregateError);
      assert.equal(outcome.errors[0].name, 'AbortError');
      assert.equal(outcome.errors[1], cleanupFailure);
      if (restoreLost) assert.match(error.errors[1].message, /rollback is unverified; reconcile/);
      return true;
    });
    assert.deepEqual(calls.slice(7), ['cases', 'settled', 'cleanup', 'current', 'restore', ...(restoreLost ? [] : ['current'])]);
  }
});

test('probe, case and cleanup deadlines abort and settle work before rollback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [phase, timeout] of [['probe', 30_000], ['exercise', 18 * 60_000], ['cleanup', 60_000]]) {
    const { run, options, calls } = fixture(t);
    const started = Promise.withResolvers();
    let aborted = false;
    const drained = Promise.withResolvers();
    options[phase] = async (identity, signal) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      started.resolve();
      await drained.promise;
      calls.push('settled');
      return phase === 'cleanup' ? true : { ...identity, ready: true };
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

test('aborts overdue probe and case settlements even when the timer has not fired', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const [phase, timeout] of [['probe', 30_000], ['exercise', 18 * 60_000]]) {
    for (const reject of [false, true]) {
      await t.test(`${phase} ${reject ? 'rejects' : 'fulfills'} at its deadline`, async t => {
        const { run, options, calls } = fixture(t);
        options[phase] = async (identity, signal) => {
          signal.addEventListener('abort', () => calls.push('abort'), { once: true });
          now += timeout;
          assert.ok(!signal.aborted);
          calls.push('settled');
          if (reject) throw new Error('late phase failure');
          return { ...identity, ready: true };
        };
        await assert.rejects(run(), { name: 'TimeoutError' });
        assert.deepEqual(calls.slice(-5), ['settled', 'abort', 'current', 'restore', 'current']);
        if (phase === 'probe') assert.ok(!calls.includes('cases'));
      });
    }
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
    await assert.rejects(run(), error => {
      if (failure === 'late-activation') {
        assert.ok(error instanceof AggregateError);
        assert.match(error.errors[0].message, /Bounded staging Worker API call failed/);
        error = error.errors[1];
      }
      assert.match(error.message, /rollback is unverified/);
      return true;
    });
    assert.equal(calls.includes('restore'), failure.startsWith('restore'));
  }
});

function recoveryFixture(t) {
  const f = fixture(t);
  const { sha, runId, attempt } = f.identity;
  const source = { sha, runId, attempt };
  const record = { ...source, ...f.options.upload, kind: 'worker' };
  const baselineVersion = () => ({ id: baseline, resources: { bindings: f.state.candidateBindings.slice(0, 2) } });
  const recover = (overrides = {}, sourceAttempt = source) => recoverQualificationWorker(sourceAttempt,
    { ...record, ...overrides }, { ...f.env, GITHUB_JOB: 'recover' }, f.cwd, f.controller.signal, async (url, init) => {
      await f.state.beforeRequest?.(init);
      if (init.method === 'GET' && url.endsWith(`/versions/${baseline}`)) {
        f.calls.push('baseline-version');
        return json(f.state.baselineVersion ?? baselineVersion());
      }
      const response = await f.request(url, init);
      f.state.afterRequest?.();
      return response;
    });
  f.state.current = deployment(active, candidate, f.state.tag);
  return { ...f, recover, source, baselineVersion };
}

test('lost-run recovery restores only the recorded candidate and confirms the tagged baseline', async t => {
  const { recover, calls, state, git, app } = recoveryFixture(t);
  t.mock.method(Date, 'now', () => Number(expiresAt) + 1);
  writeFileSync(join(app, 'wrangler.staging.json'), 'not the source attempt config');
  git('commit', '-qam', 'later main');
  git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
  const evidence = { status: 'restored', deployment: restored, version: baseline };
  assert.deepEqual(await recover(), evidence);
  assert.equal(state.current.annotations['workers/message'], `restore-${state.tag}`);
  assert.deepEqual(calls.splice(0), ['current', 'baseline-version', 'version', 'current', 'restore', 'current']);
  assert.deepEqual(await recover(), evidence);
  assert.deepEqual(calls.splice(0), ['current', 'baseline-version', 'current']);
  state.current = deployment(prior, baseline);
  assert.deepEqual(await recover(), { status: 'baseline-observed', deployment: prior, version: baseline });
  assert.deepEqual(calls, ['current', 'baseline-version', 'current']);
});

test('lost-run recovery rejects mismatched and non-main source attempts before provider access', async t => {
  const { recover, calls, source, git } = recoveryFixture(t);
  for (const record of [{ attempt: '3' }, { kind: 'd1' }, { previousVersion: candidate }, { expiresAt: 'never' }]) {
    await assert.rejects(recover(record), /recovery is unverified/);
  }
  git('commit', '-q', '--allow-empty', '-m', 'not on main');
  const sha = git('rev-parse', 'HEAD');
  await assert.rejects(recover({ sha }, { ...source, sha }), /recovery is unverified/);
  assert.deepEqual(calls, []);
});

test('lost-run recovery verifies published attempt bindings and can still restore an older candidate', async t => {
  const { recover, calls, state } = recoveryFixture(t);
  const bindings = state.candidateBindings;
  state.candidateBindings = bindings.filter(binding => binding.name !== 'DRIVE_QUALIFICATION_RUN_ID');
  await assert.rejects(recover(), /recovery is unverified/);
  assert.deepEqual(calls.splice(0), ['current', 'baseline-version', 'version']);
  state.candidateBindings = bindings.map(binding => binding.name === 'DRIVE_QUALIFICATION_RUN_ATTEMPT'
    ? { ...binding, text: '3' } : binding);
  await assert.rejects(recover(), /recovery is unverified/);
  assert.deepEqual(calls.splice(0), ['current', 'baseline-version', 'version']);
  state.candidateBindings = bindings.filter(binding => !Object.hasOwn(attemptVars, binding.name));
  assert.equal((await recover()).status, 'restored');
});

test('lost-run recovery never writes when the deployment or version evidence has changed', async t => {
  const { recover, state, calls, baselineVersion } = recoveryFixture(t);
  for (const current of [deployment(foreign, candidate, 'another attempt'), deployment(foreign, baseline),
    deployment(foreign, foreign, state.tag), null]) {
    state.current = current;
    await assert.rejects(recover(), /recovery is unverified/);
    assert.deepEqual(calls.splice(0), ['current']);
  }
  state.current = deployment(active, candidate, state.tag);
  const wrongBindings = baselineVersion();
  wrongBindings.resources.bindings.push(...varsToBindings({ DRIVE_QUALIFICATION_SHA: sha }));
  state.baselineVersion = wrongBindings;
  await assert.rejects(recover(), /recovery is unverified/);
  delete state.baselineVersion;
  await assert.rejects(recover({ expiresAt: String(Number(expiresAt) - 1) }), /recovery is unverified/);
  assert.equal(calls.splice(0).includes('restore'), false);
  state.beforeRequest = () => {
    if (calls.at(-1) === 'version') state.current = deployment(foreign, candidate, state.tag);
  };
  await assert.rejects(recover(), /recovery is unverified/);
  assert.deepEqual(calls, ['current', 'baseline-version', 'version', 'current']);
});

test('lost-run recovery does not certify or retry an ambiguous restore', async t => {
  for (const failure of ['restoreLost', 'restoreIgnored', 'wrongReadbackTag']) {
    const { recover, state, calls } = recoveryFixture(t);
    state[failure] = true;
    state.beforeRequest = () => {
      if (calls.at(-1) === 'restore' && failure === 'wrongReadbackTag') {
        state.current = deployment(restored, baseline, 'other restore');
      }
    };
    await assert.rejects(recover(), { message: 'Staging Worker recovery is unverified; reconcile the recorded deployment before retrying.' });
    assert.equal(calls.filter(call => call === 'restore').length, 1);
  }
});

test('lost-run recovery rejects cancellation even when restore readback succeeds', async t => {
  const { recover, state, calls, controller } = recoveryFixture(t);
  state.afterRequest = () => {
    // The stub already accepted an un-aborted signal and produced valid readback evidence.
    if (calls.at(-2) === 'restore' && calls.at(-1) === 'current') controller.abort();
  };
  await assert.rejects(recover(), { message: 'Staging Worker recovery is unverified; reconcile the recorded deployment before retrying.' });
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(calls, ['current', 'baseline-version', 'version', 'current', 'restore', 'current']);
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
