import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { scopedSmokeTarget, smokeDispatch, smokeMigrationArgs, smokeProvider, smokeWorkerConfig } from './first-release-smoke-target.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const token = 't'.repeat(40), key = 'b'.repeat(32), now = 1_800_000_000_000;
const sha = 'c'.repeat(40);
const dispatch = { GITHUB_REPOSITORY: 'TogetherWeOwn/qerith', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: sha, EXPECTED_MAIN_SHA: sha, GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2' };
const declaration = { accountId: 'a'.repeat(32), databaseId: '00000000-0000-4000-8000-000000000001',
  databaseName: 'qerith-drive-first-release-smoke-fixture', bucket: 'qerith-drive-first-release-smoke',
  workerSubdomain: 'synthetic', scopeEvidenceDigest: 'd'.repeat(64), expiresAt: now + 3600_000,
  deployTokenHash: hash(token), accessKeyIdHash: hash(key) };
const env = { ...dispatch, CLOUDFLARE_API_TOKEN: token, QERITH_FIRST_RELEASE_SMOKE_R2_ACCESS_KEY_ID: key,
  QERITH_FIRST_RELEASE_SMOKE_R2_SECRET_ACCESS_KEY: 'e'.repeat(64), QERITH_FIRST_RELEASE_SMOKE_TARGET: JSON.stringify(declaration) };

test('binds the protected staging source and target to an exact run attempt', () => {
  const scope = smokeDispatch(dispatch);
  assert.equal(scope.worker, 'qerith-drive-first-release-smoke-42-2');
  assert.equal(scope.prefix, 'drive-first-release-smoke/42/2/');
  for (const changes of [{ GITHUB_REPOSITORY: 'togetherweown/qerith' }, { GITHUB_REF: 'refs/tags/main' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { EXPECTED_MAIN_SHA: 'a'.repeat(40) }, { GITHUB_RUN_ATTEMPT: '02' }]) {
    assert.throws(() => smokeDispatch({ ...dispatch, ...changes }), /Invalid protected smoke dispatch/);
  }
  const target = scopedSmokeTarget(env, scope, { now });
  assert.equal(target.origin, 'https://qerith-drive-first-release-smoke-42-2.synthetic.workers.dev');
  assert.equal(target.s3.endpoint, `https://${declaration.accountId}.r2.cloudflarestorage.com`);
  for (const changes of [{ databaseId: '87ac8041-ad2d-4650-b0d7-05bb78846f60' },
    { databaseName: 'qerith-drive-staging' }, { bucket: 'qerith-drive-production' }, { expiresAt: now },
    { workerSubdomain: 'other.workers.dev' }, { deployTokenHash: hash('another token') }, { accessKeyIdHash: hash('another signer') }]) {
    assert.throws(() => scopedSmokeTarget({ ...env, QERITH_FIRST_RELEASE_SMOKE_TARGET: JSON.stringify({ ...declaration, ...changes }) },
      scope, { now }), /Missing or invalid scoped smoke target/);
  }
});

function providerFixture() {
  const scope = smokeDispatch(dispatch);
  const target = scopedSmokeTarget(env, scope, { now });
  const d1 = `/d1/database/${target.databaseId}`;
  const worker = `/workers/scripts/${scope.worker}`;
  const r2 = `/r2/buckets/${target.bucket}`;
  const build = 'f'.repeat(64);
  const text = (name, value) => ({ name, type: 'plain_text', text: value });
  const bindings = [
    text('DRIVE_QUALIFICATION_SHA', sha), text('DRIVE_QUALIFICATION_RUN_ID', scope.runId),
    text('DRIVE_QUALIFICATION_RUN_ATTEMPT', String(scope.runAttempt)), text('DRIVE_FIRST_RELEASE_BUILD_DIGEST', build),
    { name: 'DB', type: 'd1', id: target.databaseId },
  ];
  const success = result => Response.json({ success: true, errors: [], result });
  const absent = code => Response.json({ success: false, errors: [{ code }] }, { status: 404 });
  const routes = new Map([
    [`GET ${d1}`, () => success({ name: target.databaseName, uuid: target.databaseId })],
    [`POST ${d1}/query`, ({ body }) => {
      assert.match(JSON.parse(body).sql, /^SELECT name FROM sqlite_schema/);
      return success([{ success: true, results: [] }]);
    }],
    [`GET ${worker}/settings`, () => absent(10007)],
    ['GET /workers/subdomain', () => success({ subdomain: target.workerSubdomain })],
    [`GET ${r2}`, () => success({ name: target.bucket, jurisdiction: 'default' })],
    [`GET ${r2}/domains/managed`, () => success({ enabled: false })],
    [`GET ${r2}/domains/custom`, () => success({ domains: [] })],
    [`GET ${r2}/lifecycle`, () => success({ rules: [{
      enabled: true, conditions: { prefix: 'drive-first-release-smoke/' },
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86_400 } },
      abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 86_400 } },
    }] })],
  ]);
  const trace = [];
  const api = smokeProvider(target, scope, async (url, options) => {
    const base = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}`;
    assert.ok(url.startsWith(base + '/'));
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, `Bearer ${token}`);
    const op = `${options.method} ${url.slice(base.length)}`;
    trace.push(op);
    return routes.get(op)(options);
  });
  return { api, routes, d1, worker, r2, trace, success, absent, bindings, build };
}

test('checks only the named database, Worker and bucket before writes', async () => {
  const { api, routes, d1, worker, r2, trace, success } = providerFixture();
  await api.preflight();
  assert.deepEqual(trace, [`GET ${d1}`, `POST ${d1}/query`, `GET ${worker}/settings`, 'GET /workers/subdomain',
    `GET ${r2}`, `GET ${r2}/domains/managed`, `GET ${r2}/domains/custom`, `GET ${r2}/lifecycle`]);
  routes.set(`GET ${r2}/domains/managed`, () => success({ enabled: true }));
  await assert.rejects(api.preflight(), /privacy unverified/);
  routes.set(`POST ${d1}/query`, () => success([{ success: true, results: [{ name: 'drive_principals' }] }]));
  trace.length = 0;
  await assert.rejects(api.preflight(), /must be fresh and empty/);
  assert.deepEqual(trace, [`GET ${d1}`, `POST ${d1}/query`]);
});

test('cleanup deletes only owned attempt resources and requires absence readback', async () => {
  const { api, routes, d1, worker, trace, success, absent, bindings, build } = providerFixture();
  routes.set(`GET ${worker}/settings`, () => success({ bindings }));
  routes.set(`DELETE ${worker}`, () => {
    routes.set(`GET ${worker}/settings`, () => absent(10007));
    return success({});
  });
  routes.set(`DELETE ${d1}`, () => success({}));
  await assert.rejects(api.stopWorker('0'.repeat(64)), /Cannot verify cleanup ownership/);
  assert.deepEqual(trace, [`GET ${worker}/settings`]);
  await api.stopWorker(build);
  assert.deepEqual(trace.slice(1), [`GET ${worker}/settings`, `DELETE ${worker}`, `GET ${worker}/settings`]);
  await assert.rejects(api.removeDb(), /removal could not be verified/);
  routes.set(`DELETE ${d1}`, () => {
    routes.set(`GET ${d1}`, () => absent(7404));
    return success({});
  });
  await api.removeDb();
  assert.deepEqual(trace.slice(-3), [`GET ${d1}`, `DELETE ${d1}`, `GET ${d1}`]);
});

test('locked Wrangler applies smoke migrations through the pinned D1 binding', async () => {
  const scope = smokeDispatch(dispatch), target = scopedSmokeTarget(env, scope, { now });
  const config = JSON.parse(await readFile(new URL('../wrangler.build.jsonc', import.meta.url), 'utf8'));
  await using temp = await mkdtempDisposable(join(tmpdir(), 'drive-smoke-d1-'));
  const configPath = join(temp.path, 'wrangler.json'), storage = join(temp.path, 'storage');
  const settings = smokeWorkerConfig(config, { ...scope, buildDigest: 'f'.repeat(64) }, target, now);
  assert.equal(settings.d1_databases[0].database_id, target.databaseId);
  await writeFile(configPath, JSON.stringify(settings));
  const options = { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } };
  const wrangler = resolve('node_modules/.bin/wrangler');
  execFileSync(wrangler, [...smokeMigrationArgs(configPath), '--local', '--persist-to', storage], options);
  const output = execFileSync(wrangler, ['d1', 'execute', 'DB', '--local', '--config', configPath, '--persist-to', storage,
    '--json', '--command', "SELECT name FROM sqlite_schema WHERE name = 'drive_principals'"], options);
  assert.deepEqual(JSON.parse(output)[0].results, [{ name: 'drive_principals' }]);
});

test('invalid source cannot replace a queued staging deployment', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/drive-first-release-smoke.yml', import.meta.url), 'utf8');
  const source = workflow.match(/^  source:\n([\s\S]*?)^  smoke:\n/m)?.[1];
  assert.ok(source);
  assert.doesNotMatch(workflow, /^concurrency:/m);
  assert.doesNotMatch(source, /^    concurrency:/m);
  assert.match(source, /Verify protected dispatch[\s\S]+EXPECTED_MAIN_SHA[^\n]+GITHUB_SHA/);
  assert.match(workflow, /  smoke:\n    needs: source\n    if: success\(\) && needs\.source\.result == 'success'\n    concurrency:\n      group: drive-staging-lifecycle/);
});

test('protected workflow has one success-only attempt receipt', async () => {
  const source = await readFile(new URL('../../../.github/workflows/drive-first-release-smoke.yml', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/^  [a-z_]+:$/gm)].filter(([text]) => text === '  workflow_dispatch:').length, 1);
  assert.match(source, /environment: staging/);
  assert.match(source, /github\.ref == 'refs\/heads\/main'/);
  assert.match(source, /if: always\(\) && inputs\.staging_venue == 'cloudflare'[\s\S]*first-release-smoke\.mjs cleanup/);
  assert.equal([...source.matchAll(/uses: actions\/upload-artifact@/g)].length, 1);
  assert.match(source, /upload-artifact@[^\n]+\n\s+if: success\(\)[\s\S]+name: drive-first-release-smoke-\$\{\{ github\.sha \}\}-attempt-\$\{\{ github\.run_attempt \}\}/);
});

test('protected workflow separates local staging from Cloudflare credentials', async () => {
  const source = await readFile(new URL('../../../.github/workflows/drive-first-release-smoke.yml', import.meta.url), 'utf8');
  assert.match(source, /default: github-hosted-local\n\s+options: \[github-hosted-local, cloudflare\]/);
  assert.match(source, /"\$STAGING_VENUE" != github-hosted-local && "\$STAGING_VENUE" != cloudflare/);
  assert.match(source, /if: inputs\.staging_venue == 'github-hosted-local'\n\s+run: [^\n]*scripts\/first-release-smoke-local\.mjs\n/);
  assert.match(source, /if: inputs\.staging_venue == 'cloudflare'\n\s+env: &smoke_credentials\n\s+QERITH_FIRST_RELEASE_SMOKE_TARGET:/);
});
