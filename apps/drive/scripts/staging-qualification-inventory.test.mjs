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
const pinnedBucket = { name: bucket, jurisdiction: 'default' };
const bucketPage = { total_count: 1, per_page: 10 };
const namespacePage = { page: 1, per_page: 10, count: 0, total_count: 0, total_pages: 0 };
const namespaceRoster = (overrides, init) => Response.json({ success: true, errors: [], messages: [], result: [],
  result_info: namespacePage, ...overrides }, init);
const bucketRoster = (overrides, init) => Response.json({ success: true, errors: [], messages: [],
  result: { buckets: [pinnedBucket] }, result_info: bucketPage, ...overrides }, init);
const streamEmpty = { liveInputs: [], range: 0, total: 0 };
const streamRoster = (overrides, init) => Response.json({ success: true, errors: [], messages: [],
  result: streamEmpty, ...overrides }, init);
const beforeR2 = ['estate', 'd1-roster', 'fixtures', 'd1-fixtures', 'namespaces', 'containers', 'stream'];
const r2Jurisdictions = ['default', 'eu', 'us', 'fedramp', 'fedramp-high'];
const r2RosterOrder = ['r2-roster', ...r2Jurisdictions.map(jurisdiction => `r2-roster-${jurisdiction}`)];
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
      if (url === `${root}${storageAccount}/r2/buckets?per_page=10`) {
        const jurisdiction = init.headers['cf-r2-jurisdiction'];
        const kind = jurisdiction ? `r2-roster-${jurisdiction}` : 'r2-roster';
        assert.ok(r2RosterOrder.includes(kind));
        trace.push(kind);
        assert.deepEqual(init.headers, { authorization: 'Bearer fixture-token',
          ...(jurisdiction && { 'cf-r2-jurisdiction': jurisdiction }) });
        state.onBucketList?.(jurisdiction, init.signal);
        const empty = jurisdiction && jurisdiction !== 'default';
        return (jurisdiction ? state.scopedBucketLists?.[jurisdiction] : state.bucketList) ??
          bucketRoster(empty ? { result: { buckets: [] }, result_info: { total_count: 0 } } : {},
            state.partial === kind ? { headers: { 'Content-Range': 'bytes 0-99/200' } } : undefined);
      }
      if (url === `${root}${storageAccount}/r2/buckets/${bucket}/lifecycle`) {
        trace.push('expiry');
        if (state.expiryDocument) return state.expiryDocument;
        const age = seconds => ({ condition: { type: 'Age', maxAge: seconds } });
        const response = json({ rules: !state.expiry ? [] : [{ enabled: true, conditions: { prefix: namespace },
          deleteObjectsTransition: age(3 * 86400), abortMultipartUploadsTransition: age(7 * 86400) },
        ...(state.recordRetention ? [{ enabled: true, conditions: { prefix: 'drive-qualification/recovery/' },
          deleteObjectsTransition: age(3 * 86400) }] : [])] }, state.expiryPage);
        if (state.partial === 'expiry') response.headers.set('Content-Range', 'bytes 0-99/200');
        if (state.expiryLink) response.headers.set('Link', '</schema>; rel="describedby"');
        return response;
      }
      if (url === `${root}${account}/workers/durable_objects/namespaces?page=1&per_page=10`) {
        trace.push('namespaces');
        assert.deepEqual(init.headers, { authorization: 'Bearer fixture-token' });
        state.onNamespaceList?.(init.signal);
        return state.namespaceList ?? namespaceRoster();
      }
      if (url === `${root}${account}/containers/applications`) {
        trace.push('containers');
        assert.deepEqual(init.headers, { authorization: 'Bearer fixture-token' });
        state.onContainerList?.(init.signal);
        return state.containerList ?? json([]);
      }
      if (url === `${root}${account}/stream/live_inputs?include_counts=true`) {
        trace.push('stream');
        assert.deepEqual(init.headers, { authorization: 'Bearer fixture-token' });
        state.onStreamList?.(init.signal);
        return state.streamList ?? streamRoster();
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
  f.state.bucketList = bucketRoster({ result_info: { total_count: 1, cursor: '' }, messages: ['ok'] });
  f.state.expiryLink = true;
  assert.equal(await run('after'), true);
  await assert.rejects(run('after'), error);
  const expected = [...beforeR2, ...r2RosterOrder, 'expiry', 'uploads', 'objects',
    'scripts', 'deployments', 'versions', 'schedules', 'deployments'];
  assert.deepEqual(f.trace, [...expected, ...expected]);
});

test('inventory rejects a native Durable Object namespace before and after the attempt', async t => {
  const f = fixture(t);
  for (const phase of ['before', 'after']) {
    const run = f.create();
    if (phase === 'after') assert.equal(await run('before'), true);
    f.trace.length = 0;
    f.state.namespaceList = namespaceRoster({ result: [{ name: 'unbound' }],
      result_info: { ...namespacePage, count: 1, total_count: 1, total_pages: 1 } });
    await assert.rejects(run(phase), error);
    assert.deepEqual(f.trace, ['estate', 'd1-roster', 'fixtures', 'd1-fixtures', 'namespaces']);
  }
});

test('inventory requires a complete, bounded native Durable Object namespace roster', async t => {
  const f = fixture(t);
  for (const reply of [namespaceRoster({ result_info: { total_count: 0 } }),
    namespaceRoster({ result_info: { ...namespacePage, total_pages: 1 } })]) {
    const run = f.create();
    f.state.namespaceList = reply;
    assert.equal(await run('before'), true);
  }
  for (const reply of [namespaceRoster({ result: {} }), namespaceRoster({ result_info: undefined }),
    namespaceRoster({ result_info: { page: 1 } }), namespaceRoster({ messages: ['unexpected'] }),
    ...[{ page: 2 }, { per_page: 1 }, { count: 1 }, { total_count: 1 }, { total_pages: 2 }, { cursor: 'next' }]
      .map(page => namespaceRoster({ result_info: { ...namespacePage, ...page } })),
    namespaceRoster({ success: false }), namespaceRoster({}, { status: 403 }),
    namespaceRoster({}, { headers: { Link: '</next>; rel="next"' } }),
    namespaceRoster({}, { headers: { 'Content-Range': 'bytes 0-9/100' } }),
    new Response((await namespaceRoster().text()).padEnd(65_537, ' ')), new Response('not JSON')]) {
    const run = f.create();
    f.trace.length = 0;
    f.state.namespaceList = reply;
    await assert.rejects(run('before'), error);
    assert.equal(f.trace.at(-1), 'namespaces');
  }
});

test('inventory rejects a native Durable Object namespace result after its deadline', async t => {
  const f = fixture(t), run = f.create();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const aborted = [];
  f.state.onNamespaceList = signal => {
    t.mock.timers.tick(4_999);
    aborted.push(signal.aborted);
    t.mock.timers.tick(1);
    aborted.push(signal.aborted);
  };
  await assert.rejects(run('before'), error);
  assert.deepEqual(aborted, [false, true]);
  assert.equal(f.trace.at(-1), 'namespaces');
});

test('inventory rejects any native container application before and after the attempt', async t => {
  const f = fixture(t);
  for (const phase of ['before', 'after']) {
    const run = f.create();
    if (phase === 'after') assert.equal(await run('before'), true);
    f.state.containerList = json([{ name: 'unbound', instances: 0 }]);
    await assert.rejects(run(phase), error);
    assert.equal(f.trace.at(-1), 'containers');
  }
});

test('inventory requires a complete, bounded native container roster', async t => {
  const f = fixture(t);
  const roster = { success: true, errors: [], messages: [], result: [] };
  const empty = f.create();
  f.state.containerList = Response.json({ ...roster, result_info: {} });
  assert.equal(await empty('before'), true);
  f.state.containerList = Response.json({ ...roster, result_info: { next_page_token: '' } });
  assert.equal(await empty('after'), true);
  for (const reply of [
    Response.json({ ...roster, success: false }), Response.json({ ...roster, result: undefined }),
    Response.json({ ...roster, errors: [{ code: 10000 }] }), Response.json({ ...roster, messages: ['partial'] }),
    ...[null, [], '', { next_page_token: 'more' }, { next_page_token: ' ' }, { next_page_token: null }, { cursor: 'more' }]
      .map(result_info => Response.json({ ...roster, result_info })),
    Response.json({ ...roster, result: { applications: [] } }), Response.json(roster, { status: 403 }),
    Response.json(roster, { headers: { Link: '</next>; rel="next"' } }), Response.json(roster, { status: 206 }),
    Response.json(roster, { headers: { 'Content-Range': 'bytes 0-9/100' } }),
    new Response(JSON.stringify(roster).padEnd(65_537, ' ')), new Response('not JSON'),
  ]) {
    const run = f.create();
    f.state.containerList = reply;
    await assert.rejects(run('before'), error);
    assert.equal(f.trace.at(-1), 'containers');
  }
});

test('inventory rejects duplicate native container roster members', async t => {
  const f = fixture(t);
  for (const fields of [
    '"result":[{}],"result":[]',
    '"result":[{}],"res\\u0075lt":[]',
    '"result":[],"result_info":{"next_page_token":"more","next_page_token":""}',
  ]) {
    const run = f.create();
    f.state.containerList = new Response(`{"success":true,"errors":[],${fields}}`);
    await assert.rejects(run('before'), error);
    assert.equal(f.trace.at(-1), 'containers');
  }
});

test('inventory rejects a native container roster returned after its deadline', async t => {
  const f = fixture(t), run = f.create();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const aborted = [];
  f.state.onContainerList = signal => {
    t.mock.timers.tick(4_999);
    aborted.push(signal.aborted);
    t.mock.timers.tick(1);
    aborted.push(signal.aborted);
  };
  await assert.rejects(run('before'), error);
  assert.deepEqual(aborted, [false, true]);
  assert.equal(f.trace.at(-1), 'containers');
});

test('inventory rejects any native Stream input before and after the attempt', async t => {
  const f = fixture(t);
  for (const phase of ['before', 'after']) {
    const run = f.create();
    if (phase === 'after') assert.equal(await run('before'), true);
    // Zero counts must not override a disabled input in the array.
    f.state.streamList = streamRoster({ result: { ...streamEmpty, liveInputs: [{ enabled: false }] } });
    await assert.rejects(run(phase), error);
    assert.equal(f.trace.at(-1), 'stream');
  }
});

test('inventory requires a complete, bounded native Stream roster', async t => {
  const f = fixture(t);
  for (const reply of [
    streamRoster({ success: false }), streamRoster({ messages: ['partial'] }), streamRoster({ errors: [{ code: 1 }] }),
    ...[[], { total: 0, range: 0 }, { liveInputs: [] }, { ...streamEmpty, total: 1 }, { ...streamEmpty, range: 1 },
      { ...streamEmpty, total: '0' }, { ...streamEmpty, cursor: 'next' }].map(result => streamRoster({ result })),
    streamRoster({ result_info: { cursor: 'next' } }), streamRoster({}, { headers: { Link: '</next>; rel="next"' } }),
    streamRoster({}, { status: 403 }), streamRoster({}, { status: 206 }),
    streamRoster({}, { headers: { 'Content-Range': 'bytes 0-9/100' } }), new Response('not JSON'),
    new Response((await streamRoster().text()).padEnd(65_537, ' ')),
    new Response('{"success":true,"errors":[],"messages":[],"result":{"liveInputs":[],"range":0,"total":1,"total":0}}'),
  ]) {
    const run = f.create();
    f.state.streamList = reply;
    await assert.rejects(run('before'), error);
    assert.equal(f.trace.at(-1), 'stream');
  }
});

test('inventory rejects a native Stream roster returned after its deadline', async t => {
  const f = fixture(t), run = f.create();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const aborted = [];
  f.state.onStreamList = signal => {
    t.mock.timers.tick(4_999);
    aborted.push(signal.aborted);
    t.mock.timers.tick(1);
    aborted.push(signal.aborted);
  };
  await assert.rejects(run('before'), error);
  assert.deepEqual(aborted, [false, true]);
  assert.equal(f.trace.at(-1), 'stream');
});

test('inventory rejects an extra native R2 bucket before and after the attempt', async t => {
  const f = fixture(t);
  for (const [index, jurisdiction] of r2Jurisdictions.entries()) {
    for (const phase of ['before', 'after']) {
      const run = f.create();
      if (phase === 'after') assert.equal(await run('before'), true);
      f.trace.length = 0;
      const buckets = [...(jurisdiction === 'default' ? [pinnedBucket] : []), { name: 'extra', jurisdiction }];
      f.state.scopedBucketLists = { [jurisdiction]: bucketRoster({ result: { buckets },
        result_info: { total_count: buckets.length } }) };
      await assert.rejects(run(phase), error);
      assert.deepEqual(f.trace, [...beforeR2, ...r2RosterOrder.slice(0, index + 2)]);
    }
  }
});

test('inventory requires a complete bounded native R2 bucket roster', async t => {
  const f = fixture(t);
  const invalid = [bucketRoster({ result: { buckets: [] } }),
    bucketRoster({ result: { buckets: [{ ...pinnedBucket, jurisdiction: 'eu' }] } }),
    bucketRoster({ result: { buckets: [{ ...pinnedBucket, name: 'wrong' }] } }),
    bucketRoster({ result_info: undefined }), bucketRoster({ result_info: { per_page: 10 } }),
    bucketRoster({ result_info: { ...bucketPage, per_page: 1 } }),
    bucketRoster({ result_info: { ...bucketPage, total_count: 2 } }),
    bucketRoster({ messages: [42] }),
    bucketRoster({ result_info: { ...bucketPage, is_truncated: true } }),
    bucketRoster({ result_info: { ...bucketPage, cursor: 'next' } }),
    bucketRoster({ result: { buckets: [pinnedBucket], cursor: 'next' } }),
    bucketRoster({}, { headers: { Link: '</next>; rel="next"' } }),
    bucketRoster({}, { headers: { 'Content-Range': 'bytes 0-9/100' } }),
    bucketRoster({}, { status: 403 }), bucketRoster({ success: false }),
    new Response('invalid JSON')];
  for (const response of invalid) {
    const run = f.create();
    f.trace.length = 0;
    f.state.bucketList = response;
    await assert.rejects(run('before'), error);
    assert.equal(f.trace.at(-1), 'r2-roster');
  }
  const run = f.create();
  f.state.scopedBucketLists = { fedramp: new Response(null, { status: 403 }) };
  await assert.rejects(run('before'), error);
  assert.equal(f.trace.at(-1), 'r2-roster-fedramp');
});

test('inventory caps schema-valid native R2 roster bodies at 64 KiB', async t => {
  const f = fixture(t);
  const body = await bucketRoster().text();
  const capped = body.padEnd(65_536, ' '); // Trailing JSON whitespace keeps the payload valid.
  const atLimit = f.create();
  f.state.bucketList = new Response(capped);
  assert.equal(await atLimit('before'), true);

  const overLimit = f.create();
  f.trace.length = 0;
  f.state.bucketList = new Response(`${capped} `);
  await assert.rejects(overLimit('before'), error);
  assert.equal(f.trace.at(-1), 'r2-roster');
});

test('inventory shares one 15-second deadline across native R2 roster reads', async t => {
  const f = fixture(t), run = f.create();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [], beforeDeadline = [];
  f.state.onBucketList = (jurisdiction, signal) => {
    signals.push(signal);
    if (jurisdiction === undefined) t.mock.timers.tick(10_000);
    if (jurisdiction === 'default') t.mock.timers.tick(4_999);
    beforeDeadline.push(signal.aborted);
    if (jurisdiction === 'default') t.mock.timers.tick(1);
    signal.throwIfAborted();
  };
  await assert.rejects(run('before'), error);
  assert.deepEqual(f.trace, [...beforeR2, ...r2RosterOrder.slice(0, 2)]);
  assert.deepEqual(beforeDeadline, [false, false]);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[0].aborted, true);
});

for (const [kind, configure, lastRead] of [
  ['Durable Object roster result', state => {
    state.namespaceList = new Response(`{"success":true,"errors":[],"messages":[],
      "result":[{"id":"extra"}],"result":[],"result_info":{"total_count":0}}`);
  }, 'namespaces'],
  ['R2 jurisdiction bucket list', state => {
    state.scopedBucketLists = { eu: new Response(`{"success":true,"errors":[],
      "result":{"buckets":[{"name":"extra","jurisdiction":"eu"}],"buckets":[]},"result_info":{"total_count":0}}`) };
  }, 'r2-roster-eu'],
  ['R2 lifecycle expiry', state => {
    state.expiryDocument = new Response(`{"success":true,"errors":[],"result":{"rules":[
      {"enabled":true,"conditions":{"prefix":"${namespace}"},
       "deleteObjectsTransition":{"condition":{"type":"Age","maxAge":345600,"maxAge":259200}},
       "abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":604800}}}]}}`);
  }, 'expiry'],
]) {
  test(`inventory rejects duplicate JSON members in the native ${kind}`, async t => {
    const f = fixture(t);
    const inspect = f.create();
    assert.equal(await inspect('before'), true);
    configure(f.state);
    await assert.rejects(inspect('after'), error);
    assert.equal(f.trace.at(-1), lastRead);
  });
}

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

const r2ReadOrder = [...r2RosterOrder, 'expiry', 'uploads', 'objects'];
for (const [index, kind] of r2ReadOrder.entries()) {
  test(`inventory rejects HTTP 200 with Content-Range on R2 ${kind}`, async t => {
    const f = fixture(t), run = f.create();
    f.state.partial = kind;
    await assert.rejects(run('before'), error);
    assert.deepEqual(f.trace, [...beforeR2, ...r2ReadOrder.slice(0, index + 1)]);
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
