import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('adds a nullable account name without changing retained identity data', async () => {
  const migration = '0039_member_display_names.sql';
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name < migration));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO drive_principals (id, role, status, webauthn_user_handle)
      VALUES ('retained', 'member', 'active', 'retained-handle')`),
    env.DB.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
      VALUES ('credential', 'retained', x'01', 7, '[]', 'retained-handle')`),
  ]);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect(await env.DB.prepare("SELECT * FROM drive_principals WHERE id = 'retained'").first()).toMatchObject({
    role: 'member', status: 'active', webauthn_user_handle: 'retained-handle', display_name: null,
  });
  expect(await env.DB.prepare("SELECT principal_id, counter FROM drive_credentials WHERE id = 'credential'").first())
    .toEqual({ principal_id: 'retained', counter: 7 });
  expect((await env.DB.prepare('SELECT name FROM d1_migrations WHERE name = ?').bind(migration).all()).results)
    .toEqual([{ name: migration }]);
});
