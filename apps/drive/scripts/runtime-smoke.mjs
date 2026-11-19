import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';

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
export default { fetch(request, env, ctx) {
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
    for (const name of ['0001_identity.sql', '0002_private_metadata.sql', '0009_sessions.sql', '0015_folder_listing_order.sql', '0033_owner_registration.sql']) {
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
    await DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('other', 'member', 'active')").run();

    const access = (init) => worker.fetch(`${origin}/`, init);
    assert.equal((await access()).status, 401, 'generated app recognizes its configured origin and D1 binding');
    const mutation = await access({ method: 'POST', headers: { cookie, 'content-type': 'application/json' } });
    assert.equal(mutation.status, 403, 'mutation needs the exact Origin');
    assert.equal(mutation.headers.get('cache-control'), 'private, no-store');
    for (const suffix of ['', '/']) {
      const part = await worker.fetch(`${origin}/api/uploads/fixture/parts/1${suffix}`, { redirect: 'manual' });
      assert.equal(part.status, 401, 'the private endpoint is guarded before any slash redirect');
      assert.equal(part.headers.get('cache-control'), 'private, no-store');
    }
    const authorized = await access({ headers: { cookie } });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get('cache-control'), 'private, no-store');
    assert.match(await authorized.text(), /Your drive is empty\./);
    const navigation = { 'x-test-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' };
    const fileId = '00000000-0000-4000-8000-000000000002';
    const file = `${origin}/api/download/${fileId}`;
    const get = (headers, url = file) => worker.fetch(url, { redirect: 'manual', headers });
    const folder = DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, ?, 'folder')");
    const folderId = (i) => `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`;
    await DB.batch(Array.from({ length: 100 }, (_, i) => folder.bind(folderId(i), 'fixture', `Folder ${100 + i}`)));
    await folder.bind('other-folder', 'other', 'Other principal folder').run();
    await DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes) VALUES (?, 'fixture', 'Fixture.pdf', 'file', 'internal-fixture-key', 1)").bind(fileId).run();
    const first = await (await access({ headers: { cookie } })).text();
    assert.match(first, /Folder 100/);
    assert.match(first, /Folder 199/);
    assert.doesNotMatch(first, /Fixture\.pdf|Other principal folder|Your drive is empty/);
    const next = first.match(/href="(\/\?page=[A-Za-z0-9_-]+)"/);
    assert.equal(next?.[1], `/?page=${folderId(99)}`, 'the continuation contains only the boundary ID');
    const following = await (await get({ cookie }, `${origin}${next[1]}`)).text();
    assert.match(following, /Fixture\.pdf/);
    assert.ok(following.includes(`href="/api/download/${fileId}"`));
    assert.doesNotMatch(following, /data-action-row|<th[^>]*>(?:Size|Modified|Actions)<\/th>/);
    assert.doesNotMatch(following, /Folder 199|Other principal folder|internal-fixture-key|Next page/);
    assert.ok(!following.includes(cookie.split('=')[1]));
    const invalid = await (await get({ cookie }, `${origin}/?page=invalid`)).text();
    assert.match(invalid, /This page is no longer available\./);
    assert.match(invalid, /<a\b[^>]*\shref="\/"[^>]*>Back to first page<\/a>/);
    assert.doesNotMatch(invalid, /Your drive is empty|Fixture\.pdf|Folder 100/);
    await DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(fileId).run();
    const exhausted = await (await get({ cookie }, `${origin}${next[1]}`)).text();
    assert.match(exhausted, /No more items\./);
    assert.doesNotMatch(exhausted, /Your drive is empty/);

    // Break only the listing query; the session and download guard are still live.
    const index = await DB.prepare("SELECT sql FROM sqlite_schema WHERE name = 'drive_entries_listing_asc'").first();
    await DB.prepare('DROP INDEX drive_entries_listing_asc').run();
    try {
      const failed = await (await get({ cookie }, `${origin}${next[1]}`)).text();
      assert.match(failed, /This folder didn't load/);
      const retry = failed.match(/<a\b[^>]*\shref="([^"\s]+)"[^>]*>Try again<\/a>/);
      assert.equal(retry?.[1], next[1], 'retry stays on the failed page');
    } finally {
      await DB.prepare(index.sql).run();
    }
    await DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(folderId(99)).run();
    const stale = await (await get({ cookie }, `${origin}${next[1]}`)).text();
    assert.match(stale, /This page is no longer available\./);
    assert.doesNotMatch(stale, /No more items|Your drive is empty/);
    console.log('Generated Worker: bounded private root pages, stale page recovery and same-page retry passed');
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
    const revoked = await get({ cookie, range: 'bytes=1-' });
    assert.equal(revoked.status, 401);
    assert.equal(revoked.headers.get('location'), null);
    await assertProvisioningUnavailable(await session('owner-fixture', 'owner'), 'owner');
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
