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
  expect(initial).toMatchObject({ owner_id: 'alice', state: 'created', version: 0, upload_id: null });
  expect(await intents.get('bob', initial.id)).toBeNull();
  expect(await intents.transition('bob', initial.id, 0, 'created', 'initiating')).toBeNull();
  const claims = await Promise.all([
    intents.transition('alice', initial.id, 0, 'created', 'initiating'),
    intents.transition('alice', initial.id, 0, 'created', 'initiating'),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(claims.find(Boolean)).toMatchObject({ state: 'initiating', version: 1 });
  expect(await intents.transition('bob', initial.id, 1, 'initiating', 'allocated', 'provider-id')).toBeNull();
  const providerId = 'x'.repeat(8192) + '<tag>';
  const allocated = await intents.transition('alice', initial.id, 1, 'initiating', 'allocated', providerId);
  expect(allocated).toMatchObject({ state: 'allocated', version: 2, upload_id: providerId });
  expect(await intents.transition('alice', initial.id, 1, 'initiating', 'uncertain')).toBeNull();
  await expect(intents.transition('alice', initial.id, 2, 'allocated', 'acknowledged')).rejects.toThrow();
  const completing = await intents.transition('alice', initial.id, 2, 'allocated', 'completing');
  expect(completing.version).toBe(3);
  const uncertain = await intents.transition('alice', initial.id, 3, 'completing', 'uncertain');
  expect(uncertain).toMatchObject({ state: 'uncertain', upload_id: providerId, version: 4 });
  await expect(intents.transition('alice', initial.id, 4, 'uncertain', 'acknowledged')).rejects.toThrow();
  const racing = await intents.create('alice');
  await intents.transition('alice', racing.id, 0, 'created', 'initiating');
  const outcomes = await Promise.all([
    intents.transition('alice', racing.id, 1, 'initiating', 'allocated', 'racing-id'),
    intents.transition('alice', racing.id, 1, 'initiating', 'uncertain'),
  ]);
  expect(outcomes.filter(Boolean)).toHaveLength(1);
  expect((await intents.get('alice', racing.id)).version).toBe(2);
  const allocationUnknown = await intents.create('alice');
  await intents.transition('alice', allocationUnknown.id, 0, 'created', 'initiating');
  expect(await intents.transition('alice', allocationUnknown.id, 1, 'initiating', 'uncertain'))
    .toMatchObject({ state: 'uncertain', upload_id: null });
  await intents.recordProviderSuccess('alice', allocationUnknown.id, 1, { kind: 'allocation', uploadId: 'late-id' });
  await intents.recordProviderSuccess('alice', allocationUnknown.id, 1, { kind: 'allocation', uploadId: 'wrong-id' });
  expect(await intents.get('alice', allocationUnknown.id))
    .toMatchObject({ state: 'uncertain', upload_id: 'late-id', version: 3 });
  await intents.recordProviderSuccess('alice', initial.id, 3, { kind: 'completion' });
  expect(await intents.get('alice', initial.id))
    .toMatchObject({ state: 'uncertain', upload_id: providerId, completion_acknowledged: 1, version: 5 });
  const acknowledged = await intents.create('alice');
  await intents.transition('alice', acknowledged.id, 0, 'created', 'initiating');
  await intents.transition('alice', acknowledged.id, 1, 'initiating', 'allocated', 'other-id');
  await intents.transition('alice', acknowledged.id, 2, 'allocated', 'completing');
  expect(await intents.transition('alice', acknowledged.id, 3, 'completing', 'acknowledged'))
    .toMatchObject({ state: 'acknowledged', version: 4 });
  expect((await env.DB.prepare('SELECT id FROM drive_entries').all()).results).toEqual([{ id: 'folder' }]);
  const pending = await intents.create('alice');
  await intents.transition('alice', pending.id, 0, 'created', 'initiating');
  const pendingCompletion = await intents.create('alice');
  await intents.transition('alice', pendingCompletion.id, 0, 'created', 'initiating');
  await intents.transition('alice', pendingCompletion.id, 1, 'initiating', 'allocated', 'completion-id');
  await intents.transition('alice', pendingCompletion.id, 2, 'allocated', 'completing');
  const unclaimed = await intents.create('alice');
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  expect(await intents.get('alice', initial.id)).toBeNull();
  expect(await intents.transition('alice', unclaimed.id, 0, 'created', 'initiating')).toBeNull();
  expect(await intents.transition('alice', pending.id, 1, 'initiating', 'uncertain')).toBeNull();
  await intents.recordProviderUncertainty('alice', pending.id, 1, 'allocation');
  await intents.recordProviderSuccess('alice', pending.id, 1, { kind: 'allocation', uploadId: 'revoked-id' });
  await intents.recordProviderSuccess('alice', pendingCompletion.id, 3, { kind: 'completion' });
  expect(await intents.get('alice', pending.id)).toBeNull();
  expect(await intents.get('bob', pending.id)).toBeNull();
  expect(await env.DB.prepare('SELECT state, upload_id FROM drive_upload_intents WHERE id = ?').bind(pending.id).first())
    .toEqual({ state: 'uncertain', upload_id: 'revoked-id' });
  expect(await env.DB.prepare('SELECT state, completion_acknowledged FROM drive_upload_intents WHERE id = ?').bind(pendingCompletion.id).first())
    .toEqual({ state: 'acknowledged', completion_acknowledged: 1 });
  expect(await env.DB.prepare('SELECT state, upload_id FROM drive_upload_intents WHERE id = ?').bind(initial.id).first())
    .toEqual({ state: 'uncertain', upload_id: providerId });
});
