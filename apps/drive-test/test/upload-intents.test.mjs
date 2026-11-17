import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';

it('upgrades existing metadata and keeps upload outcomes private and versioned', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name < '0016_upload_intents.sql'));
  await env.DB.prepare('INSERT INTO drive_principals VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
    .bind('alice', 'member', 'active', 'bob', 'member', 'active', 'revoked', 'member', 'revoked').run();
  await env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('folder', 'alice', 'folder', 'folder')").run();
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect(await env.DB.prepare("SELECT name FROM drive_entries WHERE id = 'folder'").first()).toEqual({ name: 'folder' });
  expect((await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map((row) => row.name))
    .toEqual(env.DRIVE_MIGRATIONS.map(({ name }) => name));

  const intents = new UploadIntents(env.DB);
  expect(await intents.create('revoked')).toBeNull();
  const initial = await intents.create('alice');
  expect(initial).toMatchObject({ owner_id: 'alice', state: 'initiating', version: 0, upload_id: null });
  expect(await intents.get('bob', initial.id)).toBeNull();
  expect(await intents.transition('bob', initial.id, 0, 'initiating', 'allocated', 'provider-id')).toBeNull();
  const allocated = await intents.transition('alice', initial.id, 0, 'initiating', 'allocated', 'provider-id');
  expect(allocated).toMatchObject({ state: 'allocated', version: 1, upload_id: 'provider-id' });
  expect(await intents.transition('alice', initial.id, 0, 'initiating', 'uncertain')).toBeNull();
  await expect(intents.transition('alice', initial.id, 1, 'allocated', 'acknowledged')).rejects.toThrow();
  const completing = await intents.transition('alice', initial.id, 1, 'allocated', 'completing');
  expect(completing.version).toBe(2);
  const uncertain = await intents.transition('alice', initial.id, 2, 'completing', 'uncertain');
  expect(uncertain).toMatchObject({ state: 'uncertain', upload_id: 'provider-id', version: 3 });
  await expect(intents.transition('alice', initial.id, 3, 'uncertain', 'acknowledged')).rejects.toThrow();
  const racing = await intents.create('alice');
  const outcomes = await Promise.all([
    intents.transition('alice', racing.id, 0, 'initiating', 'allocated', 'racing-id'),
    intents.transition('alice', racing.id, 0, 'initiating', 'uncertain'),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect((await intents.get('alice', racing.id)).version).toBe(1);
  const allocationUnknown = await intents.create('alice');
  expect(await intents.transition('alice', allocationUnknown.id, 0, 'initiating', 'uncertain'))
    .toMatchObject({ state: 'uncertain', upload_id: null });
  const acknowledged = await intents.create('alice');
  await intents.transition('alice', acknowledged.id, 0, 'initiating', 'allocated', 'other-id');
  await intents.transition('alice', acknowledged.id, 1, 'allocated', 'completing');
  expect(await intents.transition('alice', acknowledged.id, 2, 'completing', 'acknowledged'))
    .toMatchObject({ state: 'acknowledged', version: 3 });
  expect((await env.DB.prepare('SELECT id FROM drive_entries').all()).results).toEqual([{ id: 'folder' }]);
  const pending = await intents.create('alice');
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  expect(await intents.get('alice', initial.id)).toBeNull();
  expect(await intents.transition('alice', pending.id, 0, 'initiating', 'uncertain')).toBeNull();
  expect(await env.DB.prepare('SELECT state, upload_id FROM drive_upload_intents WHERE id = ?').bind(initial.id).first())
    .toEqual({ state: 'uncertain', upload_id: 'provider-id' });
});
