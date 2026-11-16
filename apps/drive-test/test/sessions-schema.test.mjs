import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('upgrades seeded data and replays the full migration ledger safely', async () => {
  const prior = env.DRIVE_MIGRATIONS.filter(({ name }) => name < '0009_sessions.sql');
  await applyD1Migrations(env.DB, prior);
  await env.DB.exec("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active')");
  await env.DB.prepare('INSERT INTO drive_credentials VALUES (?, ?, ?, ?, ?)')
    .bind('credential', 'member', new Uint8Array([1, 2]), 0, '[]').run();
  const ledger = async () => (await env.DB.prepare('SELECT id, name FROM d1_migrations ORDER BY id').all()).results;
  const before = await ledger();
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const after = await ledger();
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.map(({ name }) => name)).toEqual(env.DRIVE_MIGRATIONS.map(({ name }) => name));
  expect(await env.DB.prepare("SELECT principal_id, counter FROM drive_credentials WHERE id = 'credential'").first())
    .toEqual({ principal_id: 'member', counter: 0 });
  await expect(env.DB.prepare('INSERT INTO drive_sessions VALUES (?, ?, ?)')
    .bind('a'.repeat(64), 'missing', 9999999999999).run()).rejects.toThrow();
});
