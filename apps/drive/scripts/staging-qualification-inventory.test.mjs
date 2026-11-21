import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { qualificationPrefix } from './staging-qualification.mjs';
import { createQualificationInventory } from './staging-qualification-inventory.mjs';
import { createQualificationEstate } from './staging-qualification-estate.mjs';
import { createQualificationLifecycle, runQualificationLifecycle } from './staging-qualification-lifecycle.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';
import { qualificationReadiness, stagingOrigin } from '../src/lib/server/qualification-readiness.ts';

const json = result => Response.json({ success: true, errors: [], result });
const dbBinding = { name: 'DB', type: 'd1', id: '87ac8041-ad2d-4650-b0d7-05bb78846f60' };
const resourceBindings = [dbBinding, { name: 'ASSETS', type: 'assets' }];

const account = '209cf7dd678adfb683947dd7874d05af';
const database = dbBinding.id;
const storageAccount = 'a'.repeat(32), bucket = 'fixture-bucket';
const worker = 'qerith-drive-staging', namespace = 'drive-qualification/full-v0/';
const endpoint = `https://${storageAccount}.r2.cloudflarestorage.com`;
const uuid = digit => `${digit.repeat(8)}-0000-0000-0000-000000000000`;
const scan = (items = []) => ({ complete: true, items });
const error = { message: 'Qualification estate inventory is unverified.' };

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'drive-inventory-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Drive', '-c', 'user.email=drive@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main', '--template=');
  const dir = join(cwd, 'apps/drive/scripts');
  mkdirSync(dir, { recursive: true });
  copyFileSync(new URL('../wrangler.staging.json', import.meta.url), join(dir, '../wrangler.staging.json'));
  const identitySha256 = createHash('sha256').update(JSON.stringify([JSON.stringify([endpoint, bucket, 'fixture']),
    'auto', 'fixture-key'])).digest('hex');
  writeFileSync(join(dir, 'staging-storage-qualification.json'), JSON.stringify({ version: 1, passed: true, failures: [],
    cleanup: 'verified', scope: { identitySha256, policySha256: 'a'.repeat(64) },
    sourceSha: 'b'.repeat(40), runId: '1', runAttempt: 1, completionTimeoutMs: 3000 }));
  git('add', '.'); git('commit', '-qm', 'synthetic inventory scope');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const context = { sha, runId: '182', attempt: '3' };
  context.prefix = qualificationPrefix(context);
  const env = { GITHUB_REPOSITORY: 'TogetherWeOwn/qerith', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    TESTED_SHA: sha, GITHUB_SHA: sha, GITHUB_ACTIONS: 'true', GITHUB_JOB: 'qualification',
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/drive-staging-qualification.yml@refs/heads/main',
    GITHUB_RUN_ID: context.runId, GITHUB_RUN_ATTEMPT: context.attempt, CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_API_TOKEN: 'fixture-token', QERITH_S3_ENDPOINT: endpoint, QERITH_S3_BUCKET: bucket, QERITH_S3_REGION: 'auto',
    QERITH_S3_STORAGE_EPOCH: 'fixture', QERITH_S3_ACCESS_KEY_ID: 'fixture-key', QERITH_S3_SECRET_ACCESS_KEY: 'fixture-secret' };
  const trace = [];
  const defaults = () => ({ version: uuid('1'), deployment: uuid('2'), expiry: true, fixtures: scan(),
    estate: { workers: scan([{ name: worker }]), databases: scan([{ id: database, compute: 'on-demand' }]),
      buckets: scan([{ account: storageAccount, name: bucket }]), containers: scan(), durableObjects: scan(),
      alarms: scan(), scheduledWorkers: scan(), streamInputs: scan(), otherCompute: scan() } });
  let state = defaults();
  const reads = {
    async readEstate(scope, signal) {
      assert.deepEqual(scope, { account, storageAccount }); signal.throwIfAborted(); trace.push('estate');
      state.onEstate?.();
      return state.estate;
    },
    async readFixtures(scope, signal) {
      assert.deepEqual(scope, { account, database }); signal.throwIfAborted(); trace.push('fixtures');
      return state.fixtures;
    },
    async request(url, init) {
      assert.equal(init.redirect, 'error'); init.signal.throwIfAborted();
      const root = 'https://api.cloudflare.com/client/v4/accounts/';
      const json = (result, paginated) => Response.json({ success: true, errors: [], result,
        ...(paginated && { result_info: { cursor: 'more' } }) });
      const d1 = `${root}${account}/d1/database/${database}`;
      if (url === `${d1}/query`) {
        assert.equal(init.method, 'POST');
        assert.match(JSON.parse(init.body).batch[0].sql, /^SELECT EXISTS/);
        trace.push('d1-fixtures');
        return json([{ success: true, results: [{ invite_present: state.migrationResidue ? 1 : 0, ceremony_present: 0 }] }]);
      }
      assert.equal(init.method, 'GET');
      if (url === `${root}${account}/d1/database?page=1&per_page=10`) {
        trace.push('d1-roster');
        assert.equal(init.headers.authorization, 'Bearer fixture-token');
        assert.equal(init.headers['x-jurisdiction'], undefined);
        return state.databaseList ?? json([{ uuid: database, name: worker }]);
      }
      if (url === d1) return json({ uuid: database, name: worker, version: 'production' });
      if (url === `${root}${storageAccount}/r2/buckets/${bucket}/lifecycle`) {
        trace.push('expiry');
        const age = seconds => ({ condition: { type: 'Age', maxAge: seconds } });
        const response = json({ rules: !state.expiry ? [] : [{ enabled: true, conditions: { prefix: namespace },
          deleteObjectsTransition: age(3 * 86400), abortMultipartUploadsTransition: age(7 * 86400) },
        ...(state.recordRetention ? [{ enabled: true, conditions: { prefix: 'drive-qualification/recovery/' },
          deleteObjectsTransition: age(3 * 86400) }] : [])] }, state.expiryPage);
        if (state.partial === 'expiry') response.headers.set('Content-Range', 'bytes 0-99/200');
        return response;
      }
      const scripts = `${root}${account}/workers/scripts`;
      if (url === scripts) {
        trace.push('scripts');
        assert.equal(init.headers.authorization, 'Bearer fixture-token');
        return state.scriptList ?? json([{ id: worker }]);
      }
      const pinned = `${scripts}/${worker}/`;
      assert.ok(url.startsWith(pinned));
      const path = url.slice(pinned.length); trace.push(path.split('/')[0]);
      if (path === 'schedules') return json({ schedules: [] }, state.cronPage);
      if (path === 'deployments') return json({ deployments: [{ id: state.deployment,
        annotations: { 'workers/message': state.message }, versions: [{ version_id: state.version, percentage: 100 }] }] });
      assert.equal(path, `versions/${state.version}`);
      return json({ id: state.version, resources: { bindings: resourceBindings } });
    },
    async send(request) {
      const url = new URL(request.url);
      assert.equal(request.method, 'GET'); assert.equal(url.origin + url.pathname, `${endpoint}/${bucket}/`);
      const prefix = url.searchParams.get('prefix');
      assert.ok(prefix === namespace || (state.cleanup && prefix === context.prefix));
      assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
      const stale = `<Key>${namespace}11/2/stale</Key>`;
      const uploads = url.searchParams.has('uploads'), kind = uploads ? 'uploads' : 'objects';
      trace.push(prefix === context.prefix ? 'r2-cleanup' : kind);
      const init = state.partial === kind ? { headers: { 'Content-Range': 'bytes 0-99/200' } } : undefined;
      const paginated = uploads ? state.uploadPage : state.objectPage;
      const envelope = `<Prefix>${prefix}</Prefix><EncodingType>url</EncodingType><IsTruncated>${!!paginated}</IsTruncated>`;
      if (uploads) return new Response(`<ListMultipartUploadsResult><Bucket>${bucket}</Bucket>${envelope}${state.upload ?
        `<Upload>${stale}<UploadId>pending</UploadId></Upload>` : ''}${paginated ?
        '<NextKeyMarker>next</NextKeyMarker><NextUploadIdMarker>next</NextUploadIdMarker>' : ''}</ListMultipartUploadsResult>`, init);
      return new Response(`<ListBucketResult><Name>${bucket}</Name>${envelope}<KeyCount>${state.object ? 1 : 0}</KeyCount>${
        state.object ? `<Contents>${stale}</Contents>` : ''}${paginated ? '<NextContinuationToken>next</NextContinuationToken>' : ''}</ListBucketResult>`, init);
    },
  };
  const create = () => {
    state = defaults();
    const inspect = createQualificationInventory(env, cwd, reads);
    return (phase, overrides, signal) => inspect({ ...context, phase, ...overrides }, signal);
  };
  return { context, create, trace, env, cwd, reads, get state() { return state; } };
}

test('composed lifecycle has no default admission or transport', async t => {
  const { env, cwd } = fixture(t);
  const unused = () => assert.fail('Preparation must not call adapters');
  await assert.rejects(createQualificationLifecycle(env, cwd, { send: unused }), /requires reviewed admission/);
  await assert.rejects(createQualificationLifecycle(env, cwd, { assertFullV0: unused }), /requires.*explicit transport/);
});

function nativeWorkerFixture(cwd, candidate, context, reads, state, trace) {
  const app = join(cwd, 'apps/drive');
  for (const dir of ['.svelte-kit/cloudflare', 'node_modules/.bin']) mkdirSync(join(app, dir), { recursive: true });
  writeFileSync(join(app, '.svelte-kit/cloudflare/_worker.js'), 'unused');
  writeFileSync(join(app, 'node_modules/.bin/wrangler'), 'unused');
  const { sha, runId, attempt } = context;
  const tag = `${sha}-${runId}-${attempt}`;
  const { version, previousVersion, expiresAt } = candidate;
  const script = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}`;
  const d1 = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}`;
  return async (url, init) => {
    init.signal.throwIfAborted();
    if (url.startsWith(stagingOrigin)) {
      assert.equal(state.version, version);
      trace.push('probe');
      return qualificationReadiness(new Request(url, init), { DRIVE_ORIGIN: stagingOrigin,
        DRIVE_QUALIFICATION_SHA: sha, DRIVE_QUALIFICATION_VERSION: { id: version } }, true);
    }
    if (url === `${script}/versions/${version}`) {
      return json({ id: version, annotations: { 'workers/tag': tag }, resources: { bindings: [...resourceBindings,
        { name: 'DRIVE_QUALIFICATION_SHA', type: 'plain_text', text: sha },
        { name: 'DRIVE_QUALIFICATION_EXPIRES_AT', type: 'plain_text', text: expiresAt },
        { name: 'DRIVE_QUALIFICATION_VERSION', type: 'version_metadata' }] } });
    }
    if (url === `${script}/deployments` && init.method === 'POST') {
      const activation = state.version === previousVersion;
      const target = activation ? version : previousVersion;
      const message = activation ? tag : `restore-${tag}`;
      assert.deepEqual(JSON.parse(init.body), { strategy: 'percentage', versions: [{ version_id: target, percentage: 100 }],
        annotations: { 'workers/message': message } });
      Object.assign(state, { version: target, message, deployment: uuid(activation ? '4' : '5'), restorePending: !activation });
      trace.push(activation ? 'activate' : 'restore');
      return json({ id: state.deployment });
    }
    if (url === `${script}/deployments` && state.restorePending) {
      trace.push('restore-readback');
      state.restorePending = false;
    }
    if ((url === d1 || url === `${d1}/query`) && state.cleanup && state.version === version) {
      assert.equal(state.version, version);
      trace.push('d1-cleanup');
      return json(url === d1 ? { uuid: database, name: worker, version: 'production' } :
        [{ success: true, results: [] }, { success: true, results: [] }]);
    }
    return reads.request(url, init);
  };
}

for (const fault of ['admission', 'retention', 'default retention', 'retention after upload', 'd1', 'retention after D1', 'worker', null]) test(`composed lifecycle fails closed: ${fault ?? 'case failure after activation'}`, async t => {
  const { context, trace, env, cwd, reads, state } = fixture(t);
  const noRetention = ['retention', 'default retention'].includes(fault);
  state.recordRetention = !noRetention;
  const stored = new Map();
  const candidate = { version: uuid('3'), previousVersion: state.version, previousDeployment: state.deployment,
    expiresAt: String(Date.now() + 25 * 60_000) };
  const unused = () => assert.fail('Unexpected app adapter');
  const unexpectedNetwork = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected network request'));
  const reachesWorker = ['retention after D1', 'worker', null].includes(fault);
  const nativeRequest = reachesWorker ? nativeWorkerFixture(cwd, candidate, context, reads, state, trace) : reads.request;
  const identity = { sha: context.sha, runId: context.runId, attempt: context.attempt };
  const { expiresAt, version } = candidate;
  const inputs = { ...reads, readFileFixtures: unused, openTransferClient: unused, openDeletion: unused,
    async withAccessFixtures(scope, signal) {
      signal.throwIfAborted();
      assert.deepEqual(scope, { ...context, version });
      assert.equal(state.version, version);
      trace.push('cases');
      throw new Error('Synthetic case failure');
    },
    readWriterFence(source, signal) {
      signal.throwIfAborted();
      assert.deepEqual(source, { ...identity, version, expiresAt });
      assert.equal(state.version, version);
      trace.push('fence');
      state.cleanup = true;
      const at = Date.now(), fenced = { state: 'fenced', at };
      return { signal: new AbortController().signal, snapshot: { observedAt: at,
        fence: { since: at, until: at + 60_000, coverage: 'exclusive', superseded: false, current: identity },
        runner: fenced, candidate: { ...fenced, version, expiresAt }, inFlight: fenced, storageUrls: fenced,
        storageInFlight: fenced, providerOperations: fenced } };
    },
    assertFullV0(scope, signal) {
      signal.throwIfAborted(); assert.deepEqual(scope, context); trace.push('admission');
      return fault !== 'admission';
    },
    async send(request, init) {
      if (typeof request === 'string') return nativeRequest(request, init);
      const path = new URL(request.url).pathname;
      if (!path.includes('/recovery/')) return reads.send(request);
      const kind = path.includes('-d1-') ? 'd1' : 'worker';
      const { sha, runId, attempt } = context;
      assert.equal(request.url, `${endpoint}/${bucket}/drive-qualification/recovery/drive-staging-recovery-${kind}-${sha}-run-${runId}-attempt-${attempt}`);
      assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
      trace.push(`${kind} ${request.method}`);
      if (request.method === 'PUT') {
        assert.equal(request.headers.get('if-none-match'), '*');
        const bytes = Buffer.from(await request.arrayBuffer());
        assert.deepEqual(JSON.parse(bytes), { schema: 'drive-staging-recovery.v1', kind, sha, runId, attempt,
          ...(kind === 'd1' ? { bookmark: 'offline_bookmark' } : candidate) });
        stored.set(kind, bytes);
        return new Response(null, { headers: { etag: '"created"' } });
      }
      const bytes = fault === kind ? Buffer.from('{}') : stored.get(kind);
      const date = new Date().toUTCString();
      return new Response(bytes, { headers: { date, 'last-modified': date, 'content-length': bytes.length } });
    },
  };
  const run = await createQualificationLifecycle(env, cwd, inputs, fault === 'default retention' ? undefined : {
    upload() {
      trace.push('upload');
      if (fault === 'retention after upload') state.recordRetention = false;
      return candidate;
    },
    async migrate({ recordRecovery }) {
      await recordRecovery({ bookmark: 'offline_bookmark' });
      if (fault === 'retention after D1') state.recordRetention = false;
      trace.push('migrate');
    },
  });
  assert.deepEqual(trace, []);
  await assert.rejects(run(), fault === 'admission' ? /admission is unverified/ : noRetention ? /recovery retention is unverified/ :
    fault ? /recovery record is unverified/ : /access.*unverified|unverified.*access/);
  await assert.rejects(run(), /already started/);
  const milestones = ['admission', 'estate', 'upload', 'd1 PUT', 'd1 GET', 'migrate', 'worker PUT', 'worker GET',
    'activate', 'probe', 'cases', 'fence', 'restore', 'restore-readback'];
  assert.deepEqual(trace.filter(step => milestones.includes(step)), ['admission',
    ...(fault === 'admission' ? [] : ['estate']),
    ...(fault === 'admission' || noRetention ? [] : ['upload']),
    ...(fault === 'admission' || noRetention || fault === 'retention after upload' ? [] : ['d1 PUT', 'd1 GET']),
    ...(reachesWorker ? ['migrate'] : []),
    ...(reachesWorker && fault !== 'retention after D1' ? ['worker PUT', 'worker GET'] : []),
    ...(!fault ? ['activate', 'probe', 'cases', 'fence', 'restore', 'restore-readback'] : []),
    ...(fault === 'admission' ? [] : ['estate'])]);
  const cleanup = fault ? trace : trace.slice(trace.indexOf('fence') + 1, trace.indexOf('restore'));
  assert.deepEqual(cleanup.filter(step => step.endsWith('-cleanup')).sort(),
    fault ? [] : ['d1-cleanup', 'd1-cleanup', ...Array(4).fill('r2-cleanup')]);
  assert.equal(unexpectedNetwork.mock.callCount(), 0);
});

for (const mode of ['held', 'foreign', 'lost before headers', 'lost during body read', 'held with R2 failure']) test(
  `lifecycle estate cleanup under a ${mode} fence`, { timeout: 30_000 }, async t => {
    const { context, trace, env, cwd, reads, state } = fixture(t);
    const active = { version: uuid('3'), expiresAt: String(Date.now() + 25 * 60_000) };
    const fence = new AbortController();
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), r2Failed = Promise.withResolvers();
    const r2Fails = mode === 'held with R2 failure';
    const ops = createQualificationEstate(env, cwd, { ...reads,
      readWriterFence(source) {
        const { prefix, ...identity } = context;
        assert.deepEqual(source, { ...identity, ...active });
        trace.push('fence');
        const at = Date.now(), fenced = { state: 'fenced', at };
        return { signal: fence.signal, snapshot: { observedAt: at,
          fence: { since: at, until: at + 60_000, coverage: 'exclusive', superseded: false,
            current: { ...identity, attempt: mode === 'foreign' ? '99' : identity.attempt } },
          runner: fenced, candidate: { ...fenced, ...active }, inFlight: fenced, storageUrls: fenced,
          storageInFlight: fenced, providerOperations: fenced } };
      },
      async request(url, init) {
        if (!url.includes('/d1/database/') || !trace.includes('fence') || trace.includes('restore')) {
          return reads.request(url, init);
        }
        assert.equal(url.split('/database/')[1], `${database}${init.method === 'GET' ? '' : '/query'}`);
        trace.push('d1-cleanup');
        if (r2Fails && init.method === 'POST') {
          entered.resolve();
          await release.promise;
          trace.push('d1-drained');
        }
        return Response.json({ success: true, errors: [], result: init.method === 'GET' ?
          { uuid: database, name: worker, version: 'production' } :
          [{ success: true, results: [] }, { success: true, results: [] }] });
      },
      async send(request) {
        const url = new URL(request.url);
        if (url.searchParams.get('prefix') !== context.prefix) return reads.send(request);
        trace.push('r2-cleanup');
        if (r2Fails) {
          await entered.promise;
          trace.push('r2-failed');
          r2Failed.resolve();
          throw new Error('Offline R2 cleanup failed');
        }
        if (mode === 'lost before headers') {
          entered.resolve(); await release.promise;
          assert.equal(request.signal.aborted, true);
          trace.push('r2-drained');
        }
        if (mode === 'lost during body read') return new Response(new ReadableStream({
          pull() { entered.resolve(); },
          async cancel() {
            assert.equal(request.signal.aborted, true);
            await release.promise;
            trace.push('r2-drained');
          },
        }, { highWaterMark: 0 }));
        const xml = `<Prefix>${context.prefix}</Prefix><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>`;
        return new Response(url.searchParams.has('uploads') ?
          `<ListMultipartUploadsResult><Bucket>${bucket}</Bucket>${xml}</ListMultipartUploadsResult>` :
          `<ListBucketResult><Name>${bucket}</Name>${xml}<KeyCount>0</KeyCount></ListBucketResult>`);
      },
    });
    const run = runQualificationLifecycle({ ...ops, assertFullV0: () => true, recordRecovery: () => true,
      exercise() { trace.push('cases'); throw new Error('Offline case failed'); },
    }, env, cwd, undefined, { upload: () => active, migrate: () => null,
      async worker({ exercise, cleanup }) {
        try { await exercise(active); }
        finally {
          try { assert.equal(await runQualificationPhase(cleanup, active, undefined, 60_000), true); }
          finally {
            trace.push('restore'); state.deployment = uuid('4');
            state.message = `restore-${context.sha}-${context.runId}-${context.attempt}`;
          }
        }
      },
    });
    const rejected = assert.rejects(run, mode === 'held' ? /Offline case failed/ :
      mode === 'foreign' ? /writer quiescence is unverified/ : r2Fails ? /estate cleanup is unverified/ : { name: 'AbortError' });
    const lost = mode.startsWith('lost ');
    let recoveryBeforeDrain = [];
    if (lost || r2Fails) {
      await (lost ? entered.promise : r2Failed.promise);
      if (lost) fence.abort();
      await new Promise(resolve => setImmediate(resolve));
      recoveryBeforeDrain = trace.slice(trace.indexOf('fence') + 1).filter(step => step === 'restore' || step === 'estate');
      release.resolve();
    }
    await rejected;
    assert.deepEqual(recoveryBeforeDrain, []);
    const cleanupTrace = trace.slice(trace.indexOf('fence') + 1, trace.indexOf('restore'));
    assert.deepEqual(trace.filter(step => ['estate', 'cases', 'fence', 'restore'].includes(step)),
      ['estate', 'cases', 'fence', 'restore', 'estate']);
    if (mode === 'held') assert.deepEqual(cleanupTrace.sort(), ['d1-cleanup', 'd1-cleanup', ...Array(4).fill('r2-cleanup')]);
    if (mode === 'foreign') assert.deepEqual(cleanupTrace, []);
    if (lost) assert.equal(cleanupTrace.at(-1), 'r2-drained');
    if (r2Fails) assert.deepEqual(cleanupTrace.slice(-2), ['r2-failed', 'd1-drained']);
  });

test('inventory reads only pinned resources and compares the exact attempt baseline', async t => {
  const f = fixture(t), run = f.create();
  await assert.rejects(run('after'), error);
  await assert.rejects(run('before', { attempt: '4' }), error);
  assert.deepEqual(f.trace, []);
  assert.equal(await run('before'), true);
  f.state.deployment = uuid('3');
  f.state.message = `restore-${f.context.sha}-${f.context.runId}-${f.context.attempt}`;
  assert.equal(await run('after'), true);
  await assert.rejects(run('after'), error);
  const expected = ['estate', 'd1-roster', 'fixtures', 'd1-fixtures', 'expiry', 'uploads', 'objects', 'scripts', 'deployments',
    'versions', 'schedules', 'deployments'];
  assert.deepEqual(f.trace, [...expected, ...expected]);
});

test('inventory rejects an extra native Worker before and after the attempt', async t => {
  const f = fixture(t);
  for (const phase of ['before', 'after']) {
    const run = f.create();
    if (phase === 'after') assert.equal(await run('before'), true);
    f.trace.length = 0;
    f.state.scriptList = json([{ id: worker }, { id: 'unexpected-worker' }]);
    await assert.rejects(run(phase), error);
    assert.equal(f.trace.at(-1), 'scripts');
  }
});

test('inventory rejects an extra native D1 database before and after the attempt', async t => {
  const f = fixture(t);
  for (const phase of ['before', 'after']) {
    const run = f.create();
    if (phase === 'after') assert.equal(await run('before'), true);
    f.trace.length = 0;
    f.state.databaseList = json([{ uuid: database, name: worker }, { uuid: uuid('4'), name: 'unexpected' }]);
    await assert.rejects(run(phase), error);
    assert.deepEqual(f.trace, ['estate', 'd1-roster']);
  }
});

test('inventory accepts only a complete bounded native D1 roster', async t => {
  const f = fixture(t);
  const pinned = [{ uuid: database, name: worker }];
  const complete = { page: 1, per_page: 10, count: 1, total_count: 1 };
  const reply = (overrides, init) => Response.json({ success: true, errors: [], result: pinned,
    result_info: complete, ...overrides }, init);
  const run = f.create();
  f.state.databaseList = reply();
  assert.equal(await run('before'), true);
  for (const response of [reply({ result: [] }), reply({ result: [{ ...pinned[0], name: 'wrong' }] }),
    reply({ result: [{ ...pinned[0], uuid: uuid('4') }] }), reply({ result: pinned[0] }),
    reply({ result_info: { ...complete, total_count: 2 } }), reply({ result_info: { ...complete, page: 2 } }),
    reply({ result_info: { cursor: 'next' } }), reply({ success: false }), reply({}, { status: 403 }),
    reply({}, { headers: { 'Content-Range': 'bytes 0-9/100' } }), reply({}, { headers: { Link: '</next>; rel="next"' } }),
    reply({ result: [{ ...pinned[0], oversized: 'x'.repeat(65_536) }] }), new Response('not JSON')]) {
    const inspect = f.create();
    f.trace.length = 0;
    f.state.databaseList = response;
    await assert.rejects(inspect('before'), error);
    assert.deepEqual(f.trace, ['estate', 'd1-roster']);
  }
});

test('inventory requires native D1 migration fixture absence before and after the attempt', async t => {
  const f = fixture(t);
  for (const phase of ['before', 'after']) {
    const run = f.create();
    if (phase === 'after') assert.equal(await run('before'), true);
    f.trace.length = 0;
    f.state.migrationResidue = true;
    await assert.rejects(run(phase), error);
    assert.deepEqual(f.trace, ['estate', 'd1-roster', 'fixtures', 'd1-fixtures']);
  }
});

test('inventory rejects incomplete reads, extra resources, fixtures and unverified native idle controls', async t => {
  const f = fixture(t);
  for (const alter of [
    s => { delete s.estate.alarms; }, s => { s.estate.queues = scan(); },
    s => { s.estate.containers = scan([{ state: 'stopped' }]); }, s => { s.estate.streamInputs.complete = false; },
    s => { s.estate.workers.items.push({ name: 'other' }); }, s => { s.estate.buckets.items[0].name = 'other'; },
    s => { s.estate.databases.items[0].id = uuid('4'); }, s => { delete s.estate.databases.items[0].compute; },
    s => { s.estate.databases.items[0].compute = 'running'; }, s => { s.estate.durableObjects.nextCursor = 'more'; },
    s => { s.fixtures.nextCursor = 'more'; }, s => { s.fixtures.items.push({ tag: 'older-attempt' }); },
    ...['expiryPage', 'objectPage', 'uploadPage', 'object', 'upload', 'cronPage'].map(key => s => { s[key] = true; }),
    s => { s.expiry = false; },
  ]) {
    const run = f.create();
    alter(f.state);
    await assert.rejects(run('before'), error);
    await assert.rejects(run('after'), error);
  }
});

const r2ReadOrder = ['expiry', 'uploads', 'objects'];
for (const [index, kind] of r2ReadOrder.entries()) {
  test(`inventory rejects HTTP 200 with Content-Range on R2 ${kind}`, async t => {
    const f = fixture(t), run = f.create();
    f.state.partial = kind;
    await assert.rejects(run('before'), error);
    assert.deepEqual(f.trace, ['estate', 'd1-roster', 'fixtures', 'd1-fixtures', ...r2ReadOrder.slice(0, index + 1)]);
  });
}

test('inventory rejects final drift and does not rebaseline after cancellation', async t => {
  const f = fixture(t);
  for (const change of [{ version: uuid('3') }, { deployment: uuid('3'), message: 'restore-unrelated' }, { object: true },
    { fixtures: scan([{ tag: '182' }]) }, { expiry: false }]) {
    const run = f.create();
    assert.equal(await run('before'), true);
    Object.assign(f.state, change);
    await assert.rejects(run('after'), error);
  }
  const run = f.create(), controller = new AbortController();
  f.state.onEstate = () => controller.abort(new Error('not public'));
  f.trace.length = 0;
  await assert.rejects(run('before', {}, controller.signal), error);
  await assert.rejects(run('before'), error);
  assert.deepEqual(f.trace, ['estate']);
});
