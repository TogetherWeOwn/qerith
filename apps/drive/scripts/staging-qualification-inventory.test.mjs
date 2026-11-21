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
import { runQualificationLifecycle } from './staging-qualification-lifecycle.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';

const account = '209cf7dd678adfb683947dd7874d05af';
const database = '87ac8041-ad2d-4650-b0d7-05bb78846f60';
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
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); init.signal.throwIfAborted();
      const root = 'https://api.cloudflare.com/client/v4/accounts/';
      const json = (result, paginated) => Response.json({ success: true, errors: [], result,
        ...(paginated && { result_info: { cursor: 'more' } }) });
      if (url === `${root}${storageAccount}/r2/buckets/${bucket}/lifecycle`) {
        trace.push('expiry');
        const age = seconds => ({ condition: { type: 'Age', maxAge: seconds } });
        const response = json({ rules: !state.expiry ? [] : [{ enabled: true, conditions: { prefix: namespace },
          deleteObjectsTransition: age(3 * 86400), abortMultipartUploadsTransition: age(7 * 86400) }] }, state.expiryPage);
        if (state.partial === 'expiry') response.headers.set('Content-Range', 'bytes 0-99/200');
        return response;
      }
      const pinned = `${root}${account}/workers/scripts/${worker}/`;
      assert.ok(url.startsWith(pinned));
      const path = url.slice(pinned.length); trace.push(path.split('/')[0]);
      if (path === 'schedules') return json({ schedules: [] }, state.cronPage);
      if (path === 'deployments') return json({ deployments: [{ id: state.deployment,
        annotations: { 'workers/message': state.message }, versions: [{ version_id: state.version, percentage: 100 }] }] });
      assert.equal(path, `versions/${state.version}`);
      return json({ id: state.version, resources: { bindings: [{ name: 'DB', type: 'd1', id: database },
        { name: 'ASSETS', type: 'assets' }] } });
    },
    async send(request) {
      const url = new URL(request.url);
      assert.equal(request.method, 'GET'); assert.equal(url.origin + url.pathname, `${endpoint}/${bucket}/`);
      assert.equal(url.searchParams.get('prefix'), namespace);
      assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
      const stale = `<Key>${namespace}11/2/stale</Key>`;
      const uploads = url.searchParams.has('uploads'), kind = uploads ? 'uploads' : 'objects';
      trace.push(kind);
      const init = state.partial === kind ? { headers: { 'Content-Range': 'bytes 0-99/200' } } : undefined;
      const paginated = uploads ? state.uploadPage : state.objectPage;
      const envelope = `<Prefix>${namespace}</Prefix><EncodingType>url</EncodingType><IsTruncated>${!!paginated}</IsTruncated>`;
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

for (const mode of ['held', 'foreign', 'lost in transport']) test(`lifecycle estate cleanup under a ${mode} fence`,
  { timeout: 10_000 }, async t => {
    const { context, trace, env, cwd, reads, state } = fixture(t);
    const active = { version: uuid('3'), expiresAt: String(Date.now() + 25 * 60_000) };
    const fence = new AbortController();
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
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
        if (!url.includes('/d1/database/')) return reads.request(url, init);
        assert.equal(url.split('/database/')[1], `${database}${init.method === 'GET' ? '' : '/query'}`);
        trace.push('d1-cleanup');
        return Response.json({ success: true, errors: [], result: init.method === 'GET' ?
          { uuid: database, name: worker, version: 'production' } :
          [{ success: true, results: [] }, { success: true, results: [] }] });
      },
      async send(request) {
        const url = new URL(request.url);
        if (url.searchParams.get('prefix') !== context.prefix) return reads.send(request);
        trace.push('r2-cleanup');
        if (mode === 'lost in transport') {
          entered.resolve(); await release.promise;
          assert.equal(request.signal.aborted, true);
          trace.push('r2-drained');
        }
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
      mode === 'foreign' ? /writer quiescence is unverified/ : { name: 'AbortError' });
    if (mode === 'lost in transport') {
      await entered.promise;
      try {
        fence.abort();
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(!trace.includes('restore'));
      } finally { release.resolve(); }
    }
    await rejected;
    const cleanupTrace = trace.slice(trace.indexOf('fence') + 1, trace.indexOf('restore'));
    assert.deepEqual(trace.filter(step => ['estate', 'cases', 'fence', 'restore'].includes(step)),
      ['estate', 'cases', 'fence', 'restore', 'estate']);
    if (mode === 'held') assert.deepEqual(cleanupTrace.sort(), ['d1-cleanup', 'd1-cleanup', ...Array(4).fill('r2-cleanup')]);
    if (mode === 'foreign') assert.deepEqual(cleanupTrace, []);
    if (mode === 'lost in transport') assert.equal(cleanupTrace.at(-1), 'r2-drained');
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
  const expected = ['estate', 'fixtures', 'expiry', 'uploads', 'objects', 'deployments', 'versions', 'schedules', 'deployments'];
  assert.deepEqual(f.trace, [...expected, ...expected]);
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
    assert.deepEqual(f.trace, ['estate', 'fixtures', ...r2ReadOrder.slice(0, index + 1)]);
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
