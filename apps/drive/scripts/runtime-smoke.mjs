import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdtempDisposable, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';
import { deletionWorker, exerciseDeletion } from '../tests/deletion-worker-fixture.mjs';

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

async function exercisePrivateBoundary(main) {
  const origin = 'https://drive.example.test';
  const config = JSON.parse(await readFile('wrangler.build.jsonc', 'utf8'));
  await using fixture = await mkdtempDisposable('.svelte-kit/drive-boundary-');
  const configPath = resolve(join(fixture.path, 'wrangler.json'));
  const entry = resolve(join(fixture.path, 'navigation.mjs'));
  // Undici overwrites Sec-Fetch-Mode. Restore synthetic navigation metadata only in this fixture.
  await writeFile(entry, `import app from ${JSON.stringify(resolve(main))};
${deletionWorker}
export default { fetch(request, env, ctx) {
  admitDeletion(request, env.DB);
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
  const harness = createTestHarness({ workers: [{ configPath, vars: { DRIVE_ORIGIN: origin } }] });
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
    const cookie = await session('fixture', 'member');
    // Probe before an existing owner would make the bootstrap operation refuse by itself.
    await assertProvisioningUnavailable(cookie, 'member');

    const access = (init) => worker.fetch(`${origin}/`, init);
    assert.equal((await access()).status, 401, 'generated app recognizes its configured origin and D1 binding');
    assert.equal((await worker.fetch(`${origin}/sign-in`)).status, 404);
    assert.equal((await worker.fetch(`${origin}/api/sign-in/challenge`, { method: 'POST', headers: { origin } })).status, 404);
    assert.equal((await worker.fetch(`${origin}/%73ign-in`, { headers: { cookie }, redirect: 'manual' })).status, 404);
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
    assert.equal(authorized.status, 200, 'live session reaches only the existing placeholder page');
    assert.equal(authorized.headers.get('cache-control'), 'private, no-store');
    assert.match(await authorized.text(), /Service unavailable\./);
    const navigation = { 'x-test-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' };
    const file = `${origin}/api/download/00000000-0000-4000-8000-000000000002`;
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
    await assertProvisioningUnavailable(owner, 'owner');
    await exerciseDeletion({ worker, DB, origin, cookie: owner, revoked: cookie, other: await session('other-fixture', 'member') });
  } finally {
    await harness.close();
  }
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
await exercise(['tests/runtime-fixture.ts', '--config', 'wrangler.build.jsonc'], [['/', 200, 'runtime-ok']]);
await exercise(['tests/webauthn-runtime-fixture.mjs', '--config', 'wrangler.jsonc'], [['/', 200, 'webauthn-runtime-ok']]);
await exercise(['tests/ceremony-worker-fixture.ts', '--config', 'wrangler.jsonc'], [['/', 200, 'ceremony-runtime-ok']]);
console.log('Worker runtime smoke checks passed');
