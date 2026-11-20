import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdtempDisposable, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';
import { fixture as passkey, userHandle } from '../tests/ceremony-fixture.ts';
import { deletionWorker, exerciseDeletion } from '../tests/deletion-worker-fixture.mjs';
import { exerciseOwnerRoutes } from '../tests/owner-worker-fixture.mjs';

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

async function exercisePrivateBoundary(main, { preview = false, staging = false, rawOutsideStaging = false } = {}) {
  const origin = staging ? 'https://qerith-drive-staging.5150.workers.dev' : 'https://drive.example.test';
  const rawStorage = staging || rawOutsideStaging;
  const release = 'a'.repeat(40);
  const enrollmentToken = staging ? randomBytes(32).toString('base64url') : undefined;
  const config = JSON.parse(await readFile('wrangler.build.jsonc', 'utf8'));
  await using fixture = await mkdtempDisposable('.svelte-kit/drive-boundary-');
  const configPath = resolve(join(fixture.path, 'wrangler.json'));
  const entry = resolve(join(fixture.path, 'navigation.mjs'));
  // Undici overwrites Sec-Fetch-Mode. Restore synthetic navigation metadata only in this fixture.
  await writeFile(entry, `import app from ${JSON.stringify(resolve(main))};
${rawStorage ? `globalThis.fetch = (${fixtureStorage})();` : preview ? '' : deletionWorker}
if ('scheduled' in app) throw new Error('Generated preview must not expose a scheduled handler');
export default { fetch(request, env, ctx) {
  ${rawStorage || preview ? '' : 'admitDeletion(request, env.DB);'}
  ${staging ? "if (!request.headers.has('x-test-bootstrap')) env = { ...env, DRIVE_OWNER_ENROLLMENT: undefined };" : ''}
  const mode = request.headers.get('x-test-fetch-mode');
  if (mode === null) return app.fetch(request, env, ctx);
  const input = new Request(request);
  input.headers.delete('x-test-fetch-mode');
  input.headers.set('sec-fetch-mode', mode);
  return app.fetch(input, env, ctx);
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
  } : {}), ...(staging ? { DRIVE_OWNER_ENROLLMENT_RELEASE: release,
    DRIVE_OWNER_ENROLLMENT: `${release}:${Date.now() + 240_000}:${enrollmentToken}` } : {}) };
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
      const refused = await worker.fetch(`${origin}/api/uploads`, {
        method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{"size":4}',
      });
      assert.deepEqual([refused.status, await refused.text()], [503, '']);
      assert.equal(await DB.prepare('SELECT 1 FROM drive_upload_intents').first(), null);
      return;
    }
    const member = staging ? await session('member', 'member') : cookie;
    // Probe before an existing owner would make the bootstrap operation refuse by itself.
    await assertProvisioningUnavailable(member, 'member');
    await DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('other', 'member', 'active')").run();

    const access = (init) => worker.fetch(`${origin}/`, init);
    assert.equal((await access()).status, 401, 'generated app recognizes its configured origin and D1 binding');
    if (staging) {
      const get = (path, headers) => worker.fetch(`${origin}${path}`, { headers, redirect: 'manual' });
      const bootstrap = (headers = {}) => worker.fetch(`${origin}/api/deployer/owner-enrollment`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
        body: '{"operation":"challenge"}',
      });
      assert.equal((await bootstrap()).status, 404, 'qualified preview has no enrollment route');
      const grant = { 'x-test-bootstrap': '1' };
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
      for (const path of ['/shared', '/%73ign-in', '/sign-in.html', '/sign-in/__data.json', '/_app/env.js', '/api/uploads/list',
        '/api/root-listing', '/api/deployer/owner-enrollment', '/api/entries/fixture/delete']) {
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
      const intent = await send('/api/uploads', 'POST', json, JSON.stringify({ size: data.length }));
      assert.equal(intent.status, 201, 'owner can allocate');
      const upload = `/api/uploads/${(await intent.json()).id}`;
      assert.equal((await send(`${upload}/parts/1`, 'PUT', 'application/octet-stream', new TextEncoder().encode(data))).status, 204);
      const publication = await send(`${upload}/complete`, 'POST', json, JSON.stringify({ parentId: null, name }));
      assert.equal(publication.status, 201, 'owner can publish');
      assert.match(await (await get('/', { cookie })).text(), /staging-fixture\.txt/);
      const file = `/api/download/${(await publication.json()).id}`;
      const full = await get(file, { cookie });
      assert.deepEqual([full.status, await full.text()], [200, data]);
      const range = await get(file, { cookie, range: 'bytes=1-2' });
      assert.deepEqual([range.status, range.headers.get('content-range'), await range.text()], [206, 'bytes 1-2/5', 'ri']);
      assert.equal((await get(file, { cookie: member })).status, 403);
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
    const fileId = '00000000-0000-4000-8000-000000000002';
    if (preview) {
      assert.match(html, /Your drive is empty\./);
      await exerciseRootPages(DB, worker, origin, cookie, fileId);
      const owner = await session('owner-fixture', 'owner');
      await exerciseOwnerRoutes({ worker, DB, origin, owner, session, preview });
      await exerciseDeletion({ worker, DB, origin, cookie: owner, preview });
      return;
    }
    await DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, 'fixture', 'Private fixture folder', 'folder')").bind(fileId).run();
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
const unavailable = [['/', 503, 'Service unavailable'], [asset, 503, 'Service unavailable']];
for (const config of ['wrangler.jsonc', 'wrangler.build.jsonc']) {
  await exercise(['--config', config], unavailable);
}
const appWorker = `${root}/_worker.js`;
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
