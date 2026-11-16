import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('upgrades seeded members and replays the real migration directory', async () => {
  const prior = env.DRIVE_MIGRATIONS.filter(({ name }) => name < '0010_login_generations.sql');
  await applyD1Migrations(env.DB, prior);
  await env.DB.exec("INSERT INTO drive_principals VALUES ('member', 'member', 'active')");
  const ledger = async () => (await env.DB.prepare('SELECT id, name FROM d1_migrations ORDER BY id').all()).results;
  const before = await ledger();
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const generation = await env.DB.prepare("SELECT generation FROM drive_login_generations WHERE principal_id = 'member'").first();
  expect(generation.generation).toMatch(/^[a-f0-9]{64}$/);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const after = await ledger();
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.map(({ name }) => name)).toEqual(env.DRIVE_MIGRATIONS.map(({ name }) => name));
  expect(await env.DB.prepare("SELECT generation FROM drive_login_generations WHERE principal_id = 'member'").first()).toEqual(generation);
  await env.DB.exec("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'; UPDATE drive_principals SET status = 'active' WHERE id = 'member'");
  expect((await env.DB.prepare("SELECT generation FROM drive_login_generations WHERE principal_id = 'member'").first()).generation).not.toBe(generation.generation);
});
