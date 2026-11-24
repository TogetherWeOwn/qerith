import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

void test('the production shell probe exercises private admission on local D1 without S3', async () => {
  const app = resolve(import.meta.dirname, '..');
  await using fixture = await mkdtempDisposable(join(app, '.drive-production-shell-'));
  const main = join(fixture.path, 'worker.mjs');
  const migrations = join(fixture.path, 'migrations');
  const assets = join(fixture.path, 'assets');
  const configPath = join(fixture.path, 'wrangler.json');
  const origin = 'https://drive-production.example.test';
  await mkdir(migrations);
  await mkdir(assets);
  await writeFile(join(assets, 'probe.txt'), 'fixture');
  await writeFile(join(migrations, '0001_fixture.sql'), 'CREATE TABLE fixture (ready INTEGER); INSERT INTO fixture VALUES (1);');
  await writeFile(main, `export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.origin !== env.DRIVE_ORIGIN || Object.keys(env).some(key => key.startsWith('DRIVE_S3_')) ||
          await env.DB.prepare('SELECT ready FROM fixture').first('ready') !== 1) {
        return new Response(null, { status: 503 });
      }
      if (request.method === 'HEAD' && url.pathname === '/sign-in' && /^[a-f0-9]{32}$/.test(url.searchParams.get('qerith_probe'))) {
        return env.ASSETS.fetch(new Request(new URL('/probe.txt', url), { method: 'HEAD' }));
      }
      if (request.method === 'GET' && url.pathname === '/api/owner/invitations' && !url.search) {
        return new Response(null, { status: env.DENY_ANONYMOUS ? 401 : 200 });
      }
      return new Response(null, { status: 404 });
    }
  };`);
  const build = JSON.parse(await readFile(join(app, 'wrangler.build.jsonc'), 'utf8'));

  for (const denyAnonymous of [true, false]) {
    await writeFile(configPath, JSON.stringify({
      main,
      compatibility_date: build.compatibility_date,
      compatibility_flags: [...new Set([...build.compatibility_flags, 'global_fetch_strictly_public'])],
      assets: { directory: assets, binding: 'ASSETS', run_worker_first: true },
      d1_databases: [{ migrations_dir: migrations }],
      vars: { DRIVE_ORIGIN: origin, DENY_ANONYMOUS: denyAnonymous },
    }));
    const probe = spawnSync(process.execPath, ['scripts/production-shell-smoke.mjs', configPath], {
      cwd: app, env: { PATH: process.env.PATH, CI: 'true' }, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(probe.error);
    assert.equal(probe.status, denyAnonymous ? 0 : 1, probe.stderr);
    if (!denyAnonymous) assert.match(probe.stderr, /GET \/api\/owner\/invitations returned 200; expected 401/);
  }
});
