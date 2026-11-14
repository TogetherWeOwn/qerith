import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('applies a test-only migration and queries the local D1 binding', async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare('INSERT INTO migration_smoke (id, value) VALUES (?, ?)')
    .bind(1, 'local').run();
  expect(await env.DB.prepare('SELECT value FROM migration_smoke WHERE id = ?')
    .bind(1).first()).toEqual({ value: 'local' });
  const ledger = await env.DB.prepare('SELECT name FROM d1_migrations').all();
  expect(ledger.results.map((row) => row.name)).toEqual(['0001_smoke.sql']);
});
