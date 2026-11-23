import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdtempDisposable, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';
import { readinessHeaders, readinessPath } from '../src/lib/server/qualification-readiness.ts';
import { firstReleaseUploadCapBytes } from '../src/lib/server/first-release-upload-limit.mjs';
import { firstReleaseSmokePrefix, qualificationPrefix } from '../src/lib/server/qualification-scope.mjs';
import { exerciseFirstReleaseCases } from './first-release-smoke-cases.mjs';
import { routeMethods, stagingRoutes } from '../src/lib/server/staging-routes.ts';
import { fixture as passkey, userHandle } from '../tests/ceremony-fixture.ts';
import { deletionWorker, exerciseDeletion } from '../tests/deletion-worker-fixture.mjs';
import { assertEntryChangeClosed, entryChangeWorker, exerciseEntryChange } from '../tests/entry-change-worker-fixture.mjs';
import { exerciseMoveDestinations } from '../tests/move-destinations-worker-fixture.mjs';
import { exerciseOwnerRoutes } from '../tests/owner-worker-fixture.mjs';
import { exerciseReadGrants, exerciseStagingReadGrants, readGrantPath, readGrantWorker, refusePreviewReadGrants } from '../tests/read-grant-worker-fixture.mjs';
import { exerciseStagingFolder } from '../tests/staging-folder-worker-fixture.mjs';
import { exerciseStagingFolderCreate } from '../tests/staging-folder-create-worker-fixture.mjs';
import { exerciseStagingQualificationFiles } from '../tests/staging-qualification-files-worker-fixture.mjs';
import { exerciseExpectedParts, expectedPartsWorker } from '../tests/upload-expected-parts-worker-fixture.mjs';
import { exerciseUploadResume, uploadResumePath, uploadResumeWorker } from '../tests/upload-resume-worker-fixture.mjs';
import { exerciseQualificationTransferWorker, qualificationTransferStorage } from '../tests/qualification-transfer-worker-fixture.mjs';

async function exercise(args, assertions) {
  const worker = spawn('./node_modules/.bin/wrangler', ['dev', ...args, '--local', '--ip', '127.0.0.1', '--port', '18787'], {
    env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let output = '';
  worker.stdout.on('data', (chunk) => { output += chunk; });
  worker.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Wrangler readiness timed out')), 30000);
      worker.once('exit', () => { clearTimeout(timer); reject(new Error('Wrangler exited before readiness')); });
      worker.on('message', (raw) => {
        const message = JSON.parse(raw);
        if (message.event !== 'DEV_SERVER_READY') return;
        clearTimeout(timer);
        if (message.ip !== '127.0.0.1' || message.port !== 18787) reject(new Error('Unexpected Wrangler address'));
        else resolve();
      });
    });
    for (const [path, status, body] of assertions) {
      const response = await fetch(`http://127.0.0.1:18787${path}`);
      const text = await response.text();
      if (response.status !== status || (body && text !== body)) {
        throw new Error(`${path}: expected ${status} ${body}, got ${response.status} ${text.slice(0, 200)}`);
      }
      if (status === 503 && response.headers.get('cache-control') !== 'no-store') {
        throw new Error(`${path}: unavailable response must not be cached`);
      }
    }
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    worker.kill('SIGTERM');
    if (worker.exitCode === null && worker.signalCode === null) await new Promise((resolve) => worker.once('exit', resolve));
  }
}

// Serialized into the disposable staging fixture only. No outbound network fallback.
function fixtureStorage() {
  let key, bytes, completed = false;
  return async (request) => {
    const { origin, pathname, searchParams: query } = new URL(request.url);
    const match = /^\/fixture\/([a-f0-9-]+)$/.exec(pathname);
    const { method, headers } = request;
    if (origin !== 'https://storage.example.test' || !match || !headers.has('authorization')) throw new Error('Unexpected fixture target');
    if (!key && method === 'POST' && query.has('uploads')) {
      key = match[1];
      return new Response(`<InitiateMultipartUploadResult><Key>${key}</Key><UploadId>fixture</UploadId></InitiateMultipartUploadResult>`);
    }
    if (key !== match[1]) throw new Error('Unexpected fixture key');
    if (query.get('uploadId') === 'fixture' && !completed) {
      if (method === 'PUT' && !bytes && query.get('partNumber') === '1') {
        bytes = new Uint8Array(await request.arrayBuffer());
        return new Response(null, { headers: { etag: '"part"' } });
      }
      if (method === 'GET' && bytes) return new Response(`<ListPartsResult><Bucket>fixture</Bucket><Key>${key}</Key><UploadId>fixture</UploadId><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><ETag>"part"</ETag><Size>${bytes.length}</Size></Part></ListPartsResult>`);
      if (method === 'POST' && bytes && (await request.text()).includes('<PartNumber>1</PartNumber>')) {
        completed = true;
        return new Response(`<CompleteMultipartUploadResult><Bucket>fixture</Bucket><Key>${key}</Key><ETag>"object"</ETag></CompleteMultipartUploadResult>`);
      }
    }
    if (completed && !query.size && headers.get('if-match') === '"object"') {
      const evidence = { etag: '"object"', 'content-length': String(bytes.length) };
      if (method === 'HEAD') return new Response(null, { headers: evidence });
      if (method === 'GET' && !headers.has('range')) return new Response(bytes, { headers: evidence });
      if (method === 'GET' && headers.get('range') === 'bytes=1-2') return new Response(bytes.slice(1, 3), {
        status: 206, headers: { ...evidence, 'content-length': '2', 'content-range': `bytes 1-2/${bytes.length}` }
      });
    }
    throw new Error('Unexpected fixture storage operation');
  };
}

const rootDataPath = '/__data.json?x-sveltekit-invalidated=01';

async function exerciseStagingRoutes(worker, origin, owner, member) {
  const flags = {
    invite: { 'x-test-invite': '1' },
    'read-grants': { 'x-test-read-grants': '1' },
    shared: { 'x-test-invite': '1', 'x-test-shared-listing': '1' },
  };
  const navigation = { 'x-test-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' };
  for (const route of stagingRoutes) {
    const path = route.path.replaceAll(/\[(\w+)\]/g, (_, parameter) =>
      parameter === 'partNumber' ? '1' : '00000000-0000-4000-8000-000000000001');
    const probe = async (method, headers, status, location = null, body) => {
      const response = await worker.fetch(origin + path, { method, headers: { origin, ...headers }, redirect: 'manual' });
      assert.deepEqual([response.status, response.headers.get('location'), response.headers.get('cache-control')],
        [status, location, 'private, no-store'], `${method} ${path} (${Object.keys(headers).join(', ') || 'default'})`);
      if (body) assert.match(await response.text(), body);
      else await response.body?.cancel();
    };
    if ('excluded' in route) {
      for (const method of route.methods) {
        await probe(method, { cookie: owner }, route.signedOut);
        await probe(method, { cookie: owner, ...flags.shared, ...flags['read-grants'] }, route.signedOut);
      }
      continue;
    }
    const enabled = route.gate ? flags[route.gate] : {};
    for (const method of route.methods) {
      if (route.gate) {
        await probe(method, {}, 404);
        await probe(method, { cookie: owner }, 404);
      }
      if (route.gate === 'invite') await probe(method, flags['read-grants'], 404);
      if (route.gate === 'read-grants') await probe(method, flags.invite, 404);
      if (route.gate === 'shared') {
        await probe(method, { ...flags.invite, cookie: member }, 404);
        await probe(method, { 'x-test-shared-listing': '1', cookie: member }, 404);
        await probe(method, { ...enabled, cookie: owner }, 404);
        const body = method === 'GET' ? /Nothing is shared with you yet\./ : undefined;
        await probe(method, { ...enabled, cookie: member }, 200, null, body);
      }
      if (route.signedOut === 'dispatch') {
        const { target } = route;
        const status = target.kind === 'invite-ceremony' ? 400 : target.kind === 'ceremony' && target.step === 'verify' ? 401 : 200;
        await probe(method, enabled, status);
        continue;
      }
      await probe(method, enabled, 401);
      if (method === 'GET' || method === 'HEAD') {
        const next = route.signedOut === 'return-to-root' ? '/' : route.signedOut === 'return-to-route' ? path : null;
        const location = next === null ? null : `/sign-in?${new URLSearchParams({ next })}`;
        await probe(method, { ...enabled, ...navigation }, location === null ? 401 : 303, location);
      }
    }
    for (const method of routeMethods) {
      if (stagingRoutes.some(peer => peer.path === route.path && peer.methods.includes(method))) continue;
      await probe(method, { ...enabled, cookie: route.access === 'member' ? member : owner }, 404);
    }
  }
  console.log('Generated Worker fixture: staging routes honor declared methods, flags and signed-out behavior');
}

async function assertRootUploadData(response, mode, limit) {
  assert.deepEqual([response.status, response.headers.get('cache-control')], [200, 'private, no-store']);
  const { nodes } = JSON.parse((await response.text()).split('\n', 1)[0]);
  // SvelteKit serializes the page as a flattened devalue table; slot zero is the root object.
  const { data } = nodes.at(-1);
  assert.equal(data[data[0].uploadMode], mode);
  if (limit !== undefined) assert.equal(data[data[0].uploadLimit], limit);
}

async function exercisePrivateBoundary(main, {
  preview = false, staging = false, rawOutsideStaging = false,
  qualificationFiles = false, qualificationTransfer = false, stagingRoutesOnly = false, firstRelease = false,
} = {}) {
  const origin = firstRelease ? 'https://drive-smoke.example.test' : staging ? 'https://qerith-drive-staging.5150.workers.dev' : 'https://drive.example.test';
  const rawStorage = staging || rawOutsideStaging || firstRelease;
  const release = 'a'.repeat(40);
  const qualificationVersion = '00000000-0000-4000-8000-000000000002';
  const attempt = { runId: '123', attempt: '2' };
  const transferScope = Object.freeze({ ...attempt, sha: release, version: qualificationVersion, prefix: firstRelease ? firstReleaseSmokePrefix(attempt) : qualificationPrefix(attempt) });
  const smokeToken = randomBytes(32).toString('base64url');
  const enrollmentToken = staging || firstRelease ? randomBytes(32).toString('base64url') : undefined;
  const config = JSON.parse(await readFile('wrangler.build.jsonc', 'utf8'));
  await using fixture = await mkdtempDisposable('.svelte-kit/drive-boundary-');
  const configPath = resolve(join(fixture.path, 'wrangler.json'));
  const entry = resolve(join(fixture.path, 'navigation.mjs'));
  // Undici overwrites Sec-Fetch-Mode. Restore synthetic navigation metadata only in this fixture.
  await writeFile(entry, `import { withEnv } from 'cloudflare:workers';
import app, { createDriveWorker } from ${JSON.stringify(resolve(main))};
${rawStorage ? `import adapter from ${JSON.stringify(resolve('.svelte-kit/cloudflare-tmp/adapter-worker.js'))};
globalThis.fetch = ${qualificationTransfer || firstRelease ? `(${qualificationTransferStorage})(${JSON.stringify(transferScope.prefix)})` : `(${fixtureStorage})()`};` : preview ? readGrantWorker : deletionWorker}
${preview ? entryChangeWorker : ''}
${preview ? uploadResumeWorker : ''}
${preview ? expectedPartsWorker : ''}
export default {
  scheduled(event, env) {
    ${rawStorage || preview ? `// Shadow D1 without reading the real binding, even if it becomes a getter.
    return app.scheduled(event, Object.create(env, {
      DRIVE_STAGING_DELETE_DRAIN: { value: '1', enumerable: true },
      DB: { enumerable: true, get() { throw new Error('Unqualified scheduled deletion must not access D1'); } }
    }));` : 'return scheduledDeletion(event, env);'}
  },
  fetch(request, env, ctx) {
  ${rawStorage ? `const boundary = request.headers.get('x-test-grant-boundary');
  if (boundary !== null) {
    const bindings = { ...env,
      DRIVE_STAGING_READ_GRANTS: request.headers.get('x-test-read-grants') ?? undefined,
      DRIVE_SIGN_IN_FIXTURE: request.headers.get('x-test-sign-in-fixture') ?? undefined,
      DRIVE_STAGING_INVITE_ACCEPTANCE: request.headers.get('x-test-invite') ?? undefined };
    const target = boundary === 'adapter' ? adapter : app;
    return withEnv(bindings, () => target.fetch(request, bindings, ctx));
  }` : ''}
  ${preview ? 'const expected = expectedPartsRequest(request, env); if (expected) return expected;' : ''}
  ${preview ? 'const resume = resumeRequest(request, env); if (resume) return resume;' : ''}
  ${preview ? 'const grant = readGrantRequest(request, env); if (grant) return grant;' : ''}
  ${rawStorage || preview ? '' : 'const deletion = runtimeDeletion(request, env, ctx); if (deletion) return deletion;'}
  ${preview ? 'const change = entryChangeRequest(request, env); if (change) return change;' : ''}
  const mode = request.headers.get('x-test-fetch-mode');
  if (mode !== null) {
    request = new Request(request);
    request.headers.delete('x-test-fetch-mode');
    request.headers.set('sec-fetch-mode', mode);
  }
  ${staging ? `if (!request.headers.has('x-test-bootstrap')) env = { ...env, DRIVE_OWNER_ENROLLMENT: undefined };
  if (request.headers.has('x-test-closed')) env = { ...env, DRIVE_ORIGIN: 'disabled' };
  if (request.headers.has('x-test-qualification')) {
    env = { ...env, DRIVE_QUALIFICATION_SHA: ${JSON.stringify(release)},
      DRIVE_QUALIFICATION_VERSION: { id: ${JSON.stringify(qualificationVersion)} },
      DRIVE_QUALIFICATION_EXPIRES_AT: String(Date.now() + (request.headers.has('x-test-expired') ? -1 : 60_000)) };
    const missing = request.headers.get('x-test-missing-binding');
    if (missing) delete env[missing];
  }
  if (['x-test-invite', 'x-test-read-grants', 'x-test-shared-listing'].some(name => request.headers.has(name))) {
    const bindings = { ...env,
      DRIVE_STAGING_INVITE_ACCEPTANCE: request.headers.get('x-test-invite') ?? env.DRIVE_STAGING_INVITE_ACCEPTANCE,
      DRIVE_STAGING_READ_GRANTS: request.headers.get('x-test-read-grants') ?? env.DRIVE_STAGING_READ_GRANTS,
      DRIVE_STAGING_SHARED_LISTING: request.headers.get('x-test-shared-listing') ?? env.DRIVE_STAGING_SHARED_LISTING };
    if (request.headers.has('x-test-unqualified')) bindings.DRIVE_S3_STORAGE_EPOCH = 'mismatched-fixture';
    return withEnv(bindings, () => app.fetch(request, bindings, ctx));
  }` : ''}
  return app.fetch(request, env, ctx);
} };`);
  await writeFile(configPath, JSON.stringify({
    ...config,
    main: entry,
    assets: { ...config.assets, directory: resolve(config.assets.directory) },
    d1_databases: [{ binding: 'DB', database_name: 'drive-smoke', database_id: '00000000-0000-4000-8000-000000000001' }]
  }));
  const vars = { DRIVE_ORIGIN: origin, ...(preview ? { DRIVE_SIGN_IN_FIXTURE: '1' } : {}), ...(rawStorage ? {
    DRIVE_S3_ENDPOINT: 'https://storage.example.test', DRIVE_S3_BUCKET: 'fixture',
    DRIVE_S3_REGION: 'test-1', DRIVE_S3_ACCESS_KEY_ID: 'fixture', DRIVE_S3_SECRET_ACCESS_KEY: 'fixture', DRIVE_S3_STORAGE_EPOCH: 'fixture',
    DRIVE_S3_QUALIFICATION: JSON.stringify({ version: 1, region: 'test-1', completionTimeoutMs: 5000,
      storageConfigId: '["https://storage.example.test","fixture","fixture"]', sourceSha: release, runId: '1', runAttempt: 1 })
  } : {}), ...(firstRelease ? { DRIVE_FIRST_RELEASE_ORIGIN: origin, DRIVE_FIRST_RELEASE_SMOKE_TOKEN: smokeToken,
    DRIVE_STAGING_READ_GRANTS: '1', DRIVE_STAGING_SHARED_LISTING: '1' } : {}), ...(staging || firstRelease ? { DRIVE_OWNER_ENROLLMENT_RELEASE: release,
    DRIVE_OWNER_ENROLLMENT: `${release}:${Date.now() + 240_000}:${enrollmentToken}`,
    DRIVE_STAGING_DELETE_REQUESTS: '1' } : {}), ...(qualificationTransfer || firstRelease ? {
    DRIVE_STAGING_INVITE_ACCEPTANCE: '1', DRIVE_QUALIFICATION_SHA: transferScope.sha,
    DRIVE_QUALIFICATION_RUN_ID: transferScope.runId, DRIVE_QUALIFICATION_RUN_ATTEMPT: transferScope.attempt,
    DRIVE_QUALIFICATION_VERSION: { id: transferScope.version }, DRIVE_QUALIFICATION_EXPIRES_AT: String(Date.now() + 240_000),
  } : {}) };
  const harness = createTestHarness({ workers: [{ configPath, vars }] });
  try {
    await harness.listen();
    const worker = harness.getWorker();
    const { DB } = await worker.getEnv();
    for (const name of (await readdir('migrations')).filter((file) => file.endsWith('.sql')).sort()) {
      const sql = await readFile(`migrations/${name}`, 'utf8');
      await DB.batch(unstable_splitSqlQuery(sql).map((statement) => DB.prepare(statement)));
    }
    const session = async (id, role) => {
      const token = randomBytes(32).toString('base64url');
      await DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES (?, ?, 'active')").bind(id, role).run();
      await DB.prepare('INSERT INTO drive_sessions (token_hash, principal_id, expires_at) VALUES (?, ?, ?)')
        .bind(createHash('sha256').update(token).digest('hex'), id, Date.now() + 60_000).run();
      return `__Host-drive-session=${token}`;
    };
    if (firstRelease) {
      const request = (url, init) => worker.fetch(url, { ...init, redirect: 'manual',
        headers: { ...init.headers, 'x-drive-smoke-token': smokeToken } });
      assert.equal((await worker.fetch(origin + readinessPath, { method: 'HEAD' })).status, 503);
      assert.equal((await worker.fetch(origin + readinessPath, { method: 'HEAD',
        headers: { 'x-drive-smoke-token': randomBytes(32).toString('base64url') } })).status, 503);
      const result = await exerciseFirstReleaseCases({ ...transferScope, origin, runAttempt: Number(attempt.attempt) },
        enrollmentToken, AbortSignal.timeout(60_000), request, async (send, cookie) =>
          assertRootUploadData(await send('GET', '/__data.json', { cookie }), 'multipart', firstReleaseUploadCapBytes));
      assert.deepEqual(result, { uninvitedDenial: 'pass', invite: 'pass', overCapRefusal: 'pass', multipartResume: 'pass',
        byteIdenticalDownload: 'pass', share: 'pass', revoke: 'pass', permanentDeletionUnavailable: 'pass' });
      assert.equal(await DB.prepare('SELECT count(*) AS total FROM drive_upload_intents').first('total'), 1);
      assert.equal(await DB.prepare('SELECT count(*) AS total FROM drive_upload_part_operations').first('total'), 2);
      assert.equal(await DB.prepare('SELECT count(*) AS total FROM drive_object_deletion_jobs').first('total'), 0);
      console.log('Generated Worker: first-release admission, capped multipart resume, bytes, share and revoke, and deletion refusal passed');
      return;
    }
    if (qualificationFiles) {
      await exerciseStagingQualificationFiles({ worker, DB, origin, session });
      return;
    }
    if (qualificationTransfer) {
      await exerciseQualificationTransferWorker({ worker, DB, origin, scope: transferScope, session });
      return;
    }
    const assertProvisioningUnavailable = async (cookie, role) => {
      for (const path of ['/owner/bootstrap', '/api/owner/provisioning']) {
        const response = await worker.fetch(`${origin}${path}`, {
          method: 'POST', redirect: 'manual', headers: { cookie, origin, 'content-type': 'application/json' },
          body: JSON.stringify({ operation: 'challenge' })
        });
        assert.equal(response.status, 404, `${path} must not expose provisioning to a ${role} session`);
      }
      assert.equal(await DB.prepare('SELECT singleton FROM drive_owner_registration').first(), null);
    };
    let cookie = await session('fixture', staging ? 'owner' : 'member');
    if (rawOutsideStaging) {
      await refusePreviewReadGrants({ worker, origin, cookie });
      const refused = await worker.fetch(`${origin}/api/uploads`, {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{"size":4}',
      });
      assert.deepEqual([refused.status, await refused.text()], [503, '']);
      assert.equal(await DB.prepare('SELECT 1 FROM drive_upload_intents').first(), null);
      return;
    }
    const member = staging ? await session('member', 'member') : cookie;
    if (staging) await exerciseStagingRoutes(worker, origin, cookie, member);
    if (stagingRoutesOnly) return;
    // Probe before an existing owner would make the bootstrap operation refuse by itself.
    await assertProvisioningUnavailable(member, 'member');
    await DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('other', 'member', 'active')").run();

    const access = (init) => worker.fetch(`${origin}/`, init);
    assert.equal((await access()).status, 401, 'generated app recognizes its configured origin and D1 binding');
    if (staging) {
      assert.equal((await worker.scheduled({ cron: '*/15 * * * *' })).outcome, 'ok',
        'generated staging schedule stays inert without server-held deletion qualification');
      const nonce = randomBytes(16).toString('hex');
      const readiness = (headers = {}) => worker.fetch(origin + readinessPath, { method: 'HEAD', redirect: 'manual',
        headers: { [readinessHeaders.nonce]: nonce, ...headers } });
      const off = await readiness();
      const identity = response => Object.values(readinessHeaders).map(name => response.headers.get(name));
      assert.deepEqual([off.status, ...identity(off)], [404, null, null, null], 'staging without candidate identity');
      const on = await readiness({ 'x-test-qualification': '1' });
      assert.deepEqual([on.status, ...identity(on)], [204, nonce, release, qualificationVersion]);
      for (const binding of ['DB', 'ASSETS', 'DRIVE_S3_QUALIFICATION']) {
        const unready = await readiness({ 'x-test-qualification': '1', 'x-test-missing-binding': binding });
        assert.deepEqual([unready.status, ...identity(unready)], [503, null, null, null], `candidate without ${binding}`);
      }
      const get = (path, headers) => worker.fetch(`${origin}${path}`, { headers, redirect: 'manual' });
      const grant = { 'x-test-bootstrap': '1' };
      const expired = { 'x-test-qualification': '1', 'x-test-expired': '1' };
      const expiredProbe = await readiness(expired);
      assert.deepEqual([expiredProbe.status, ...identity(expiredProbe)], [503, null, null, null]);
      for (const path of ['/', '/_app/version.json', '/api/deployer/owner-enrollment']) {
        const stopped = await get(path, expired);
        assert.deepEqual([stopped.status, stopped.headers.get('cache-control')], [503, 'no-store'], path);
      }
      const enrollment = '/api/deployer/owner-enrollment';
      // GET reaches the active shortcut without starting an enrollment ceremony.
      const activeEnrollment = await get(enrollment, { ...grant, 'x-test-qualification': '1' });
      assert.deepEqual([activeEnrollment.status, activeEnrollment.headers.get('allow')], [405, 'POST']);
      const stoppedEnrollment = await get(enrollment, { ...grant, ...expired });
      assert.deepEqual([stoppedEnrollment.status, stoppedEnrollment.headers.get('cache-control')], [503, 'no-store']);
      console.log('Generated Worker fixture: readiness requires D1, assets and qualified storage; expired candidates refuse requests');
      const bootstrap = (headers = {}) => worker.fetch(`${origin}/api/deployer/owner-enrollment`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
        body: '{"operation":"challenge"}',
      });
      const inactive = await bootstrap();
      assert.deepEqual([inactive.status, await inactive.text()], [404, ''], 'qualified preview has no enrollment route');
      const closed = { ...grant, cookie, 'x-test-closed': '1' };
      for (const path of ['/', '/sign-in', '/_app/version.json', '/invite']) {
        assert.equal((await get(path, closed)).status, 503, path);
      }
      assert.equal((await bootstrap({ ...closed, authorization: `Bearer ${enrollmentToken}` })).status, 503,
        'closed publish refuses even a matching inherited enrollment grant');
      assert.equal((await bootstrap(grant)).status, 403, 'release-bound enrollment still needs the bearer');
      assert.equal((await bootstrap({ ...grant, authorization: `Bearer ${enrollmentToken}` })).status, 409,
        'release-bound enrollment remains available with qualified storage and refuses a second owner');
      const signInPage = await get('/sign-in', grant);
      assert.equal(signInPage.status, 200, 'the enrollment release keeps sign-in available');
      const publicAssets = new Set([...(await signInPage.text()).matchAll(/["']((?:\.\/|\/)?_app\/immutable\/[\w./-]+\.(?:js|css|woff2))["']/g)]
        .map(([, path]) => new URL(path, origin).pathname));
      assert.ok([...publicAssets].some(path => path.endsWith('.js')), 'sign-in references a generated client entry');
      for (const path of publicAssets) {
        const asset = await get(path);
        assert.deepEqual([asset.status, asset.headers.get('cache-control')], [200, 'private, no-store'], path);
      }
      for (const path of ['/%73ign-in', '/sign-in.html', '/sign-in/__data.json', '/_app/env.js', '/api/uploads/list',
        '/api/deployer/owner-enrollment', '/api/entries/fixture/delete']) {
        assert.equal((await get(path, { cookie })).status, 404, path);
      }
      const crossSite = { 'x-test-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' };
      for (const headers of [crossSite, { ...crossSite, cookie }]) {
        const redirected = await get('/', headers);
        assert.deepEqual([redirected.status, redirected.headers.get('location'), redirected.headers.get('set-cookie'),
          await redirected.text()], [303, '/sign-in?next=%2F', null, '']);
        assert.equal((await get(redirected.headers.get('location'), headers)).status, 200);
      }
      assert.equal((await get('/', { cookie: member })).status, 403);
      assert.equal((await get('/sign-in', { cookie: member })).status, 200);
      const probe = (cookie, headers = {}) => access({ method: 'HEAD', headers: { cookie, ...headers } });
      assert.equal((await probe(member)).status, 401);
      assert.equal((await probe(member, { origin: 'https://other.example.test' })).status, 403);
      const post = (step, headers = {}, body) => worker.fetch(`${origin}/api/sign-in/${step}`, {
        method: 'POST', headers: { origin, ...headers }, body,
      });
      for (const headers of [{ cookie }, crossSite]) {
        assert.equal((await worker.fetch(`${origin}/invite`, { method: 'HEAD', headers })).status, 404);
      }
      const verify = await post('verify');
      assert.deepEqual([verify.status, await verify.json()], [401, { code: 'denied' }]);
      async function signIn(principalId, browserCookie) {
        const issued = await post('challenge', browserCookie ? { cookie: browserCookie } : {});
        assert.equal(issued.status, 200);
        const { challenge, rpId: rpID } = await issued.json();
        const { authentication, credential } = await passkey('authentication', { challenge, origin, rpID });
        await DB.prepare('UPDATE drive_principals SET webauthn_user_handle = ? WHERE id = ?').bind(userHandle, principalId).run();
        await DB.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
          VALUES (?, ?, ?, 0, '[]', ?)`).bind(credential.id, principalId, Array.from(credential.publicKey), userHandle).run();
        return post('verify', {
          cookie: [browserCookie, issued.headers.get('set-cookie').split(';')[0]].filter(Boolean).join('; '),
          'content-type': 'application/json',
        }, JSON.stringify(authentication));
      }
      const deniedMember = await signIn('other');
      assert.deepEqual([deniedMember.status, deniedMember.headers.get('set-cookie')], [401, null]);
      assert.equal(await DB.prepare("SELECT 1 FROM drive_sessions WHERE principal_id = 'other'").first(), null);
      // The synthetic credential ID and user handle are reused by the owner case.
      await DB.batch([
        DB.prepare("DELETE FROM drive_credentials WHERE principal_id = 'other'"),
        DB.prepare("UPDATE drive_principals SET webauthn_user_handle = NULL WHERE id = 'other'")
      ]);
      const owner = await signIn('fixture', member);
      assert.equal(owner.status, 204);
      const cookies = owner.headers.getSetCookie();
      const sessionCookie = cookies.find(value => value.startsWith('__Host-drive-session='));
      assert.match(sessionCookie, /; SameSite=Lax;/);
      cookie = sessionCookie.split(';')[0];
      assert.equal((await probe(cookie)).status, 200);
      const listing = await get('/', { cookie });
      const html = await listing.text();
      assert.match(html, /Your drive is empty/);
      assert.match(html, /type="file"/, 'the staging owner gets the upload picker');
      assert.match(html, /<script\b/, 'the staging root can hydrate');
      const notice = '00000000-0000-4000-8000-000000000001';
      const document = { 'x-test-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin',
        cookie: `${cookie}; __Host-drive-download-failed-${notice}=unavailable` };
      const refresh = await get(`/__data.json?download=${notice}&x-sveltekit-trailing-slash=1&x-sveltekit-invalidated=01`, document);
      assert.deepEqual([refresh.status, refresh.headers.get('cache-control'), refresh.headers.get('set-cookie')],
        [200, 'private, no-store', null], 'root data cannot consume a download notice');
      await assertRootUploadData(refresh, 'preview');
      const memberHeaders = { cookie: member, 'x-test-invite': '1' };
      for (const headers of [{ cookie }, { cookie, 'x-test-invite': '1' }, memberHeaders]) {
        for (const [method, path] of [['GET', readGrantPath], ['PUT', `${readGrantPath}/other`], ['DELETE', `${readGrantPath}/other`]]) {
          const response = await worker.fetch(origin + path, { method, headers: { origin, ...headers }, redirect: 'manual' });
          assert.deepEqual([response.status, response.headers.get('cache-control'), await response.text()], [404, 'private, no-store', '']);
        }
      }
      const missingResume = await get(uploadResumePath('00000000-0000-4000-8000-000000000001'), memberHeaders);
      assert.deepEqual([missingResume.status, missingResume.headers.get('cache-control'), await missingResume.text()],
        [404, 'private, no-store', '']);
      // Seed the journal rather than starting an upload: only slot 1 has an acknowledgement.
      const resumeId = randomUUID(), storageKey = 'private-resume-key', uploadId = 'private-resume-upload';
      const partBytes = 16 * 1024 * 1024, declaredSize = partBytes + 3;
      const sha256 = '080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e';
      const expectedPartSha256s = sha256 + createHash('sha256').update('abc').digest('hex');
      await DB.batch([
        DB.prepare(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size, expected_part_sha256s)
          VALUES (?, 'member', ?, 'created', ?, ?)`).bind(resumeId, storageKey, declaredSize, expectedPartSha256s),
        DB.prepare('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)')
          .bind(resumeId, vars.DRIVE_S3_ENDPOINT, vars.DRIVE_S3_BUCKET, vars.DRIVE_S3_STORAGE_EPOCH),
        DB.prepare("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = 2 WHERE id = ?")
          .bind(uploadId, resumeId),
        DB.prepare("INSERT INTO drive_upload_part_operations VALUES ('staging-resume-part', ?, 'member', ?, ?, ?, 2, 1, ?)")
          .bind(resumeId, storageKey, vars.DRIVE_S3_STORAGE_EPOCH, uploadId, partBytes),
        DB.prepare("INSERT INTO drive_upload_part_byte_evidence VALUES ('staging-resume-part', ?, ?)")
          .bind(Uint8Array.from(Buffer.from(sha256, 'hex')).buffer, new TextEncoder().encode('"part"').buffer),
      ]);
      const resume = await get(uploadResumePath(resumeId), memberHeaders);
      assert.deepEqual([resume.status, resume.headers.get('cache-control'), resume.headers.get('content-type')],
        [200, 'private, no-store', 'application/json'], 'the generated staging route serves bound resume evidence');
      assert.deepEqual(await resume.json(), { declaredSize, parts: [{ partNumber: 1, sizeBytes: partBytes, sha256 }], expectedPartSha256s });
      const closedResume = await get(uploadResumePath(resumeId), { cookie: member });
      assert.deepEqual([closedResume.status, closedResume.headers.get('cache-control'), await closedResume.text()],
        [404, 'private, no-store', ''], 'the same allocation is hidden when invite mode is off');
      await assertRootUploadData(await get(rootDataPath, memberHeaders), 'multipart');
      const unqualified = await get(rootDataPath, { ...memberHeaders, 'x-test-unqualified': '1' });
      assert.deepEqual([unqualified.status, unqualified.headers.get('cache-control'), await unqualified.text()],
        [503, 'private, no-store', ''], 'staging rejects mismatched storage qualification before serializing page data');
      const noticePage = await get(`/?download=${notice}`, document);
      assert.match(noticePage.headers.get('set-cookie'), /Max-Age=0/);
      assert.match(await noticePage.text(), /didn’t download/);
      const styles = [...html.matchAll(/href="((?:\.\/|\/)?_app\/immutable\/[^"\s]+\.css)"/g)].map(([, path]) => new URL(path, origin));
      let privateAsset;
      for (const asset of styles) {
        assert.equal((await worker.fetch(asset, { headers: { cookie } })).status, 200);
        if ((await worker.fetch(asset)).status === 401) privateAsset = asset;
      }
      assert.ok(privateAsset, 'root must reference owner-only CSS');
      const send = (path, method, type, body) => worker.fetch(`${origin}${path}`, {
        method, headers: { cookie, origin, 'content-type': type, 'content-length': String(body.length) }, body, redirect: 'manual'
      });
      const json = 'application/json', data = 'drive', name = 'staging-fixture.txt';
      const closedFolder = await send('/api/folders', 'POST', json, '{"name":"Closed","parentId":null}');
      assert.deepEqual([closedFolder.status, closedFolder.headers.get('cache-control'), await closedFolder.text()], [404, 'private, no-store', '']);
      const intent = await send('/api/uploads', 'POST', json, JSON.stringify({ size: data.length }));
      assert.equal(intent.status, 201, 'owner can allocate');
      const upload = `/api/uploads/${(await intent.json()).id}`;
      assert.equal((await send(`${upload}/parts/1`, 'PUT', 'application/octet-stream', new TextEncoder().encode(data))).status, 204);
      const publication = await send(`${upload}/complete`, 'POST', json, JSON.stringify({ parentId: null, name }));
      assert.equal(publication.status, 201, 'owner can publish');
      assert.match(await (await get('/', { cookie })).text(), /staging-fixture\.txt/);
      const { id } = await publication.json();
      for (const action of ['read-grants', 'eligible-recipients']) {
        const closed = await get(`/api/entries/${id}/${action}`, { cookie, 'x-test-qualification': '1' });
        assert.deepEqual([closed.status, closed.headers.get('cache-control'), await closed.text()], [404, 'private, no-store', ''],
          `candidate readiness alone leaves ${action} closed on an owned entry`);
      }
      const generation = await DB.prepare('SELECT owner_id, etag FROM drive_published_generations WHERE entry_id = ?').bind(id).first();
      assert.deepEqual(generation, { owner_id: 'fixture', etag: '"object"' }, 'the deletion probe targets an owned, pinned generation');
      const deletionState = async () => (await DB.batch([
        DB.prepare('SELECT * FROM drive_deleted_entries WHERE entry_id = ?').bind(id),
        DB.prepare('SELECT * FROM drive_object_deletion_jobs WHERE entry_id = ?').bind(id)
      ])).map(({ results }) => results);
      assert.deepEqual(await deletionState(), [[], []]);
      const deletion = await send(`/api/entries/${id}/delete`, 'POST', json, '{"confirm":"permanent-delete"}');
      assert.deepEqual([deletion.status, deletion.headers.get('cache-control'), await deletion.text()], [404, 'private, no-store', ''],
        'generated staging POST stays closed with upload-only qualification');
      assert.deepEqual(await deletionState(), [[], []], 'a closed deletion starts neither a journal nor a job');
      const file = `/api/download/${id}`;
      const full = await get(file, { cookie });
      assert.deepEqual([full.status, await full.text()], [200, data]);
      const range = await get(file, { cookie, range: 'bytes=1-2' });
      assert.deepEqual([range.status, range.headers.get('content-range'), await range.text()], [206, 'bytes 1-2/5', 'ri']);
      assert.equal((await get(file, { cookie: member })).status, 403);
      await assertEntryChangeClosed({ worker, DB, origin, owner: cookie, member });
      await exerciseEntryChange({ worker, DB, origin, session, staging });
      await exerciseStagingFolderCreate({ worker, DB, origin, session });
      await exerciseMoveDestinations({ worker, DB, origin, session });
      await exerciseStagingReadGrants({ worker, DB, origin, session, driveOwner: cookie, download: file, downloadBytes: data });
      await exerciseStagingFolder({ worker, DB, origin, owner: cookie, member, fileId: id, downloadBytes: data });
      await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'fixture'").run();
      assert.equal((await worker.fetch(privateAsset, { headers: { cookie } })).status, 401);
      assert.equal((await get(file, { cookie })).status, 401);
      return;
    }
    if (!preview) {
      assert.equal((await worker.fetch(`${origin}/sign-in`)).status, 404);
      assert.equal((await worker.fetch(`${origin}/api/sign-in/challenge`, { method: 'POST', headers: { origin } })).status, 404);
      assert.equal((await worker.fetch(`${origin}/%73ign-in`, { headers: { cookie }, redirect: 'manual' })).status, 404);
    }
    const mutation = await access({ method: 'POST', headers: { cookie, 'content-type': 'application/json' } });
    assert.equal(mutation.status, 403, 'mutation needs the exact Origin');
    assert.equal(mutation.headers.get('cache-control'), 'private, no-store');
    for (const suffix of ['', '/']) {
      const part = await worker.fetch(`${origin}/api/uploads/fixture/parts/1${suffix}`, { redirect: 'manual' });
      assert.equal(part.status, 401, 'the private endpoint is guarded before any slash redirect');
      assert.equal(part.headers.get('cache-control'), 'private, no-store');
    }
    for (const [route, method] of [['parts/1', 'PUT'], ['complete', 'POST']]) for (const suffix of ['', '/']) {
      for (const [headers, status] of [[{ origin }, 401], [{ cookie }, 403], [{ cookie, origin }, 503]]) {
        const result = await worker.fetch(`${origin}/api/uploads/00000000-0000-4000-8000-000000000002/${route}${suffix}`,
          { method, headers: { 'content-type': 'application/json', ...headers }, redirect: 'manual' });
        assert.deepEqual([result.status, result.headers.get('cache-control')], [status, 'private, no-store'], route + suffix);
      }
    }
    const allocate = (headers, suffix = '') => worker.fetch(`${origin}/api/uploads${suffix}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"size":4}', redirect: 'manual',
    });
    for (const suffix of ['', '/']) {
      for (const [headers, status] of [[{ origin }, 401], [{ cookie }, 403],
        [{ cookie, origin: 'https://other.example.test' }, 403], [{ cookie, origin }, 503]]) {
        const result = await allocate(headers, suffix);
        assert.deepEqual([result.status, result.headers.get('cache-control')], [status, 'private, no-store'], 'allocate' + suffix);
      }
    }
    const authorized = await access({ headers: { cookie } });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get('cache-control'), 'private, no-store');
    const html = await authorized.text();
    const styles = [...html.matchAll(/href="((?:\.\/|\/)?_app\/immutable\/[^"\s]+\.css)"/g)];
    assert.ok(styles.length, 'root HTML references its styles');
    for (const [, path] of styles) {
      const response = await worker.fetch(new URL(path, origin), { headers: { cookie } });
      assert.equal(response.status, preview ? 200 : 503);
    }
    const listing = await worker.fetch(`${origin}/api/root-listing`, { headers: { cookie } });
    assert.equal(listing.status, preview ? 200 : 404);
    assert.equal(listing.headers.get('cache-control'), 'private, no-store');
    const createFolder = (name, parentId) => worker.fetch(`${origin}/api/folders`, {
      method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name, parentId }),
    });
    const fileId = '00000000-0000-4000-8000-000000000002';
    if (preview) {
      assert.match(html, /Your drive is empty\./);
      await exerciseRootPages(DB, worker, origin, cookie, fileId);
      const owner = await session('owner-fixture', 'owner');
      const data = await worker.fetch(`${origin}${rootDataPath}`, { headers: { cookie: owner }, redirect: 'manual' });
      await assertRootUploadData(data, 'disabled');
      await exerciseOwnerRoutes({ worker, DB, origin, owner, session, preview });
      await exerciseDeletion({ worker, DB, origin, cookie: owner, preview });
      await exerciseReadGrants({ worker, DB, origin, session });
      await exerciseUploadResume({ worker, DB, origin, session });
      await exerciseListingPages(DB, worker, origin, cookie);
      const root = await createFolder('Created at root', null);
      assert.deepEqual([root.status, root.headers.get('cache-control')], [201, 'private, no-store']);
      const { id } = await root.json();
      const recipients = `/api/entries/${id}/eligible-recipients`;
      const lookup = (path, method = 'GET') => worker.fetch(`${origin}${path}`, { method, headers: { cookie, origin }, redirect: 'manual' });
      for (const [path, method, status, allow] of [
        [`${recipients}?x-sveltekit-test=1`, 'GET', 400, null],
        [`${recipients}/__data.json`, 'GET', 404, null],
        [`${recipients}/__route.js`, 'GET', 404, null],
        ...routeMethods.filter(method => method !== 'GET').map(method => [recipients, method, 405, 'GET']),
      ]) {
        const response = await lookup(path, method);
        assert.deepEqual([response.status, response.headers.get('cache-control'), response.headers.get('allow'),
          response.headers.get('access-control-allow-origin'), await response.text()], [status, 'private, no-store', allow, null, '']);
      }
      const available = await lookup(`${recipients}?cursor=z`);
      assert.deepEqual([available.status, available.headers.get('cache-control'), await available.json()],
        [200, 'private, no-store', { recipients: [], nextCursor: null }]);
      const nested = await createFolder('Created inside', id);
      assert.equal(nested.status, 201);
      const body = await nested.json();
      assert.deepEqual(body, { id: body.id, parentId: id, name: 'Created inside', kind: 'folder' });
      await exerciseEntryChange({ worker, DB, origin, session });
      await exerciseExpectedParts({ worker, DB, origin, session, owner });
      return;
    }
    const closedFolder = await createFolder('Fixture disabled', null);
    assert.deepEqual([closedFolder.status, closedFolder.headers.get('cache-control'), await closedFolder.text()], [404, 'private, no-store', '']);
    await DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, 'fixture', 'Private fixture folder', 'folder')").bind(fileId).run();
    assert.match(await (await worker.fetch(`${origin}/f/${fileId}`, { headers: { cookie } })).text(), /<title>Folder unavailable · Drive<\/title>/);
    const unadmitted = await (await access({ headers: { cookie } })).text();
    assert.match(unadmitted, /Service unavailable\./);
    assert.doesNotMatch(unadmitted, /My Drive|Private fixture folder|type="file"|<script\b/);
    const navigation = { 'x-test-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' };
    const file = `${origin}/api/download/${fileId}`;
    const get = (headers, url = file) => worker.fetch(url, { redirect: 'manual', headers });
    const signedOut = await get(navigation, `${file}/?next=https://other.invalid`);
    assert.equal(signedOut.status, 303);
    assert.equal(signedOut.headers.get('location'), '/sign-in?next=%2F');
    assert.equal(signedOut.headers.get('set-cookie'), null);
    for (const [name, value] of [
      ['range', 'bytes=1-'], ['if-range', '"old"'], ['if-match', '"old"'], ['if-none-match', '"old"'],
      ['if-modified-since', 'Wed, 21 Oct 2015 07:28:00 GMT'], ['if-unmodified-since', 'Wed, 21 Oct 2015 07:28:00 GMT']
    ]) {
      for (const [auth, status] of [[{}, 401], [{ cookie }, 503]]) {
        const response = await get({ ...navigation, ...auth, [name]: value }, `${file}/`);
        assert.equal(response.status, status);
        assert.equal(response.headers.get('location'), null);
        assert.equal(response.headers.get('content-range'), null);
      }
    }
    const failures = [];
    for (let tab = 0; tab < 2; tab++) {
      const unavailable = await get({ ...navigation, cookie });
      assert.equal(unavailable.status, 303);
      const location = unavailable.headers.get('location');
      assert.match(location, /^\/\?download=[a-f0-9-]{36}$/);
      const name = `__Host-drive-download-failed-${location.split('=')[1]}`;
      assert.equal(unavailable.headers.get('set-cookie').split(';')[0], `${name}=unavailable`);
      failures.push({ location, name });
    }
    assert.notEqual(failures[0].name, failures[1].name);
    const notices = (pending) => ({ ...navigation, cookie: [cookie, ...pending.map(({ name }) => `${name}=unavailable`)].join('; ') });
    assert.doesNotMatch(await (await access({ headers: notices(failures) })).text(), /didn’t download/);
    for (const [index, { location, name }] of failures.entries()) {
      const notice = await get(notices(failures.slice(index)), `${origin}${location}`);
      assert.match(await notice.text(), /The file didn’t download\. Try again\./);
      assert.ok(notice.headers.get('set-cookie').startsWith(`${name}=`));
      assert.match(notice.headers.get('set-cookie'), /Max-Age=0/i);
      assert.doesNotMatch(await (await get(notices(failures.slice(index + 1)), `${origin}${location}`)).text(), /didn’t download/);
    }
    await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'fixture'").run();
    assert.equal((await access({ headers: { cookie } })).status, 401, 'revocation applies to the next request');
    const revokedAllocation = await allocate({ cookie, origin });
    assert.deepEqual([revokedAllocation.status, revokedAllocation.headers.get('cache-control')], [401, 'private, no-store']);
    const revoked = await get({ cookie, range: 'bytes=1-' });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.headers.get('location'), null);
    const owner = await session('owner-fixture', 'owner');
    await exerciseOwnerRoutes({ worker, DB, origin, owner, session, preview });
    await assertProvisioningUnavailable(owner, 'owner');
    await exerciseDeletion({ worker, DB, origin, cookie: owner, revoked: cookie, other: await session('other-fixture', 'member') });
  } finally {
    await harness.close();
  }
}

async function exerciseListingPages(DB, worker, origin, cookie) {
  await DB.batch([
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind)
      VALUES ('listing-folder', 'other', 'Shared folder', 'folder')`),
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
      VALUES ('listing-file', 'other', 'listing-folder', 'Child.pdf', 'file', 'private-listing-key', 1)`),
    DB.prepare("INSERT INTO drive_read_grants (entry_id, recipient_id) VALUES ('listing-folder', 'fixture')"),
  ]);
  for (const [path, body] of [
    ['/api/folder-listing?folderId=listing-folder', {
      entries: [{ id: 'listing-file', name: 'Child.pdf', kind: 'file' }],
      total: 1, order: 'binary-name', direction: 'asc', nextCursor: null,
    }],
    ['/api/shared-listing', {
      entries: [{ id: 'listing-folder', name: 'Shared folder', kind: 'folder' }], nextCursor: null,
    }],
  ]) {
    const response = await worker.fetch(`${origin}${path}`, { headers: { cookie }, redirect: 'manual' });
    assert.deepEqual([response.status, response.headers.get('cache-control')], [200, 'private, no-store'], path);
    assert.deepEqual(await response.json(), body, path);
  }
  for (const path of ['/api/folder-listing?folderId=listing-folder&x-sveltekit-test=1', '/api/shared-listing?x-sveltekit-test=1']) {
    const response = await worker.fetch(`${origin}${path}`, { headers: { cookie }, redirect: 'manual' });
    assert.deepEqual([response.status, response.headers.get('cache-control'), await response.text()], [400, 'private, no-store', ''], path);
  }
}

async function exerciseRootPages(DB, worker, origin, cookie, fileId) {
  const get = async (path) => (await worker.fetch(new URL(path, origin), { headers: { cookie } })).text();
  const folder = DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, ?, 'folder')");
  const folderId = (i) => `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`;
  await DB.batch(Array.from({ length: 100 }, (_, i) => folder.bind(folderId(i), 'fixture', `Folder ${100 + i}`)));
  await folder.bind('other-folder', 'other', 'Other principal folder').run();
  await DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes) VALUES (?, 'fixture', 'Fixture.pdf', 'file', 'internal-fixture-key', 1)").bind(fileId).run();
  const first = await get('/');
  assert.match(first, /Folder 100/);
  assert.match(first, /Folder 199/);
  assert.doesNotMatch(first, /Fixture\.pdf|Other principal folder|Your drive is empty/);
  const next = first.match(/href="(\/\?page=[A-Za-z0-9_-]+)"/);
  assert.equal(next?.[1], `/?page=${folderId(99)}`, 'the continuation contains only the boundary ID');
  const following = await get(next[1]);
  assert.match(following, /Fixture\.pdf/);
  assert.ok(following.includes(`href="/api/download/${fileId}"`));
  assert.doesNotMatch(following, /data-action-row|<th[^>]*>(?:Size|Modified|Actions)<\/th>/);
  assert.doesNotMatch(following, /Folder 199|Other principal folder|internal-fixture-key|Next page/);
  assert.ok(!following.includes(cookie.split('=')[1]));
  const invalid = await get('/?page=invalid');
  assert.match(invalid, /This page is no longer available\./);
  assert.match(invalid, /<a\b[^>]*\shref="\/"[^>]*>Back to first page<\/a>/);
  assert.doesNotMatch(invalid, /Your drive is empty|Fixture\.pdf|Folder 100/);
  await DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(fileId).run();
  const exhausted = await get(next[1]);
  assert.match(exhausted, /No more items\./);
  assert.doesNotMatch(exhausted, /Your drive is empty/);

  // Break only the listing query; the session and download guard are still live.
  const index = await DB.prepare("SELECT sql FROM sqlite_schema WHERE name = 'drive_entries_listing_asc'").first();
  await DB.prepare('DROP INDEX drive_entries_listing_asc').run();
  try {
    const failed = await get(next[1]);
    assert.match(failed, /This folder didn't load/);
    const retry = failed.match(/<a\b[^>]*\shref="([^"\s]+)"[^>]*>Try again<\/a>/);
    assert.equal(retry?.[1], next[1], 'retry stays on the failed page');
  } finally {
    await DB.prepare(index.sql).run();
  }
  await DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(folderId(99)).run();
  const stale = await get(next[1]);
  assert.match(stale, /This page is no longer available\./);
  assert.doesNotMatch(stale, /No more items|Your drive is empty/);
  console.log('Generated Worker fixture: bounded private root pages, stale page recovery and same-page retry passed');
}

const root = '.svelte-kit/cloudflare';
const asset = '/_app/version.json';
await access(`${root}${asset}`);
const appWorker = `${root}/_worker.js`;
if (process.argv.includes('--first-release-smoke-only')) {
  await exercisePrivateBoundary(appWorker, { firstRelease: true });
  process.exit();
}
if (process.argv.includes('--staging-routes-only')) {
  await exercisePrivateBoundary(appWorker, { staging: true, stagingRoutesOnly: true });
  process.exit();
}
if (!process.argv.includes('--qualification-files-only')) {
  await exercisePrivateBoundary(appWorker, { staging: true, qualificationTransfer: true });
}
if (process.argv.includes('--qualification-transfer-only')) process.exit(0);
await exercisePrivateBoundary(appWorker, { staging: true, qualificationFiles: true });
if (process.argv.includes('--qualification-files-only')) process.exit();
const unavailable = ['/', '/f/private', asset].map(path => [path, 503, 'Service unavailable']);
for (const config of ['wrangler.jsonc', 'wrangler.build.jsonc']) {
  await exercise(['--config', config], unavailable);
}
const generatedUnavailable = [...unavailable, ...['/_app/env.js', '/_app/%65nv.js'].map(
  (path) => [path, 503, 'Service unavailable']
)];
await exercise([appWorker, '--config', 'wrangler.build.jsonc'], generatedUnavailable);
console.log(`Generated Worker: ${generatedUnavailable.map(([path]) => path).join(', ')} returned 503 with Cache-Control: no-store`);
await exercisePrivateBoundary(appWorker);
await exercisePrivateBoundary(appWorker, { preview: true });
await exercisePrivateBoundary(appWorker, { staging: true });
await exercisePrivateBoundary(appWorker, { rawOutsideStaging: true });
await exercise(['tests/runtime-fixture.ts', '--config', 'wrangler.build.jsonc'], [['/', 200, 'runtime-ok']]);
await exercise(['tests/webauthn-runtime-fixture.mjs', '--config', 'wrangler.jsonc'], [['/', 200, 'webauthn-runtime-ok']]);
await exercise(['tests/ceremony-worker-fixture.ts', '--config', 'wrangler.jsonc'], [['/', 200, 'ceremony-runtime-ok']]);
console.log('Worker runtime smoke checks passed');
