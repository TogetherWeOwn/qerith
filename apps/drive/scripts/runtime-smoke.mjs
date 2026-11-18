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
  await writeFile(configPath, JSON.stringify({
    ...config,
    main: resolve(main),
    assets: { ...config.assets, directory: resolve(config.assets.directory) },
    d1_databases: [{ binding: 'DB', database_name: 'drive-smoke', database_id: '00000000-0000-4000-8000-000000000001' }]
  }));
  const harness = createTestHarness({ workers: [{ configPath, vars: { DRIVE_ORIGIN: origin } }] });
  try {
    await harness.listen();
    const worker = harness.getWorker();
    const { DB } = await worker.getEnv();
    for (const name of ['0001_identity.sql', '0009_sessions.sql']) {
      const sql = await readFile(`migrations/${name}`, 'utf8');
      await DB.batch(unstable_splitSqlQuery(sql).map((statement) => DB.prepare(statement)));
    }
    const token = randomBytes(32).toString('base64url');
    const cookie = `__Host-drive-session=${token}`;
    await DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('fixture', 'member', 'active')").run();
    await DB.prepare("INSERT INTO drive_sessions (token_hash, principal_id, expires_at) VALUES (?, 'fixture', ?)")
      .bind(createHash('sha256').update(token).digest('hex'), Date.now() + 60_000).run();

    const access = (init) => worker.fetch(`${origin}/`, init);
    assert.equal((await access()).status, 401, 'generated app recognizes its configured origin and D1 binding');
    const mutation = await access({ method: 'POST', headers: { cookie, 'content-type': 'application/json' } });
    assert.equal(mutation.status, 403, 'mutation needs the exact Origin');
    assert.equal(mutation.headers.get('cache-control'), 'private, no-store');
    const intent = '00000000-0000-4000-8000-000000000002';
    for (const [route, method] of [['parts/1', 'PUT'], ['complete', 'POST']]) {
      for (const suffix of ['', '/']) {
        const url = `${origin}/api/uploads/${intent}/${route}${suffix}`;
        const send = (headers) => worker.fetch(url, {
          method, headers: { 'content-type': 'application/json', ...headers }, redirect: 'manual'
        });
        for (const [headers, status] of [[{ origin }, 401], [{ cookie }, 403],
          [{ cookie, origin: `${origin}, ${origin}` }, 403], [{ cookie, origin }, 503]]) {
          const response = await send(headers);
          assert.equal(response.status, status, `${route}: boundary rejects without redirect or storage activation`);
          assert.equal(response.headers.get('cache-control'), 'private, no-store');
        }
      }
    }
    const authorized = await access({ headers: { cookie } });
    assert.equal(authorized.status, 200, 'live session reaches only the existing placeholder page');
    assert.equal(authorized.headers.get('cache-control'), 'private, no-store');
    assert.match(await authorized.text(), /Service unavailable\./);
    await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'fixture'").run();
    assert.equal((await access({ headers: { cookie } })).status, 401, 'revocation applies to the next request');
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
