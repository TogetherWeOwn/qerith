import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('upgrades existing invitations without inventing metadata and replays the full directory', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name < '0015_invitation_display.sql'));
  await env.DB.prepare('INSERT INTO drive_invitations (id, token_hash, expires_at) VALUES (?, ?, ?)')
    .bind('old', 'a'.repeat(64), 9999999999999).run();
  const ledger = async () => (await env.DB.prepare('SELECT id, name FROM d1_migrations ORDER BY id').all()).results;
  const before = await ledger();
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const after = await ledger();
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.map(({ name }) => name)).toEqual(env.DRIVE_MIGRATIONS.map(({ name }) => name));
  expect(await env.DB.prepare("SELECT token_hash, display_name, note, created_at FROM drive_invitations WHERE id = 'old'").first())
    .toEqual({ token_hash: 'a'.repeat(64), display_name: null, note: null, created_at: null });
  await expect(env.DB.prepare("UPDATE drive_invitations SET note = ? WHERE id = 'old'").bind('x'.repeat(141)).run()).rejects.toThrow();
});
