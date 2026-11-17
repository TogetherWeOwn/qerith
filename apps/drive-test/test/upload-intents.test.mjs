import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';

it('upgrades existing metadata with a private upload intent journal', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name < '0016_upload_intents.sql'));
  await env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('folder', 'alice', 'folder', 'folder')").run();
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect(await env.DB.prepare("SELECT name FROM drive_entries WHERE id = 'folder'").first()).toEqual({ name: 'folder' });
  expect((await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map((row) => row.name))
    .toEqual(env.DRIVE_MIGRATIONS.map(({ name }) => name));
  await env.DB.prepare("INSERT INTO drive_upload_intents (id, owner_id, object_key, state) VALUES ('intent', 'alice', 'key', 'created')").run();
  expect(await env.DB.prepare('SELECT state, version, upload_id FROM drive_upload_intents WHERE id = ?').bind('intent').first())
    .toEqual({ state: 'created', version: 0, upload_id: null });
  await expect(env.DB.prepare("INSERT INTO drive_upload_intents (id, owner_id, object_key, state) VALUES ('invalid', 'alice', 'other', 'acknowledged')").run()).rejects.toThrow();
  expect((await env.DB.prepare('SELECT id FROM drive_entries').all()).results).toEqual([{ id: 'folder' }]);
});

it('claims attempts atomically, retains late evidence and isolates revoked owners', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const entriesBefore = (await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results;
  await env.DB.prepare('INSERT INTO drive_principals VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
    .bind('alice', 'member', 'active', 'bob', 'member', 'active', 'revoked', 'member', 'revoked').run();
  const intents = new UploadIntents(env.DB);
  expect(await intents.create('revoked')).toBeNull();
  const initial = await intents.create('alice');
  expect(await intents.get('bob', initial.id)).toBeNull();
  expect(await intents.claim('bob', initial.id, 0, 'allocation')).toBeNull();
  const claims = await Promise.all([
    intents.claim('alice', initial.id, 0, 'allocation'),
    intents.claim('alice', initial.id, 0, 'allocation'),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(await intents.recordNotDispatched('alice', initial.id, 1, 'allocation')).toBe(true);
  expect(await intents.recordSuccess('alice', initial.id, 1, { kind: 'allocation', uploadId: 'stale' })).toBe(false);
  expect(await intents.claim('alice', initial.id, 0, 'allocation')).toBeNull();
  expect(await intents.claim('alice', initial.id, 2, 'allocation')).toMatchObject({ state: 'initiating', version: 3 });
  expect(await intents.recordUncertain('alice', initial.id, 3, 'allocation')).toBe(true);
  expect(await intents.claim('alice', initial.id, 4, 'allocation')).toBeNull();
  expect(await intents.recordSuccess('alice', initial.id, 3, { kind: 'allocation', uploadId: 'late-id' })).toBe(true);
  expect(await intents.recordSuccess('alice', initial.id, 3, { kind: 'allocation', uploadId: 'wrong-id' })).toBe(false);
  expect(await intents.get('alice', initial.id)).toMatchObject({ state: 'allocated', upload_id: 'late-id', version: 5 });
  expect(await intents.claim('alice', initial.id, 5, 'completion')).toMatchObject({ state: 'completing', version: 6 });
  expect(await intents.recordSuccess('alice', initial.id, 6, { kind: 'completion' })).toBe(true);

  const completion = await intents.create('alice');
  await intents.claim('alice', completion.id, 0, 'allocation');
  await intents.recordSuccess('alice', completion.id, 1, { kind: 'allocation', uploadId: 'provider-id' });
  expect(await intents.claim('alice', completion.id, 2, 'completion')).toMatchObject({ state: 'completing', version: 3 });
  expect(await intents.recordNotDispatched('alice', completion.id, 3, 'completion')).toBe(true);
  expect(await intents.claim('alice', completion.id, 4, 'completion')).toMatchObject({ version: 5 });
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  expect(await intents.get('alice', completion.id)).toBeNull();
  expect(await intents.claim('alice', completion.id, 5, 'completion')).toBeNull();
  expect(await intents.recordUncertain('alice', completion.id, 5, 'completion')).toBe(true);
  expect(await intents.recordSuccess('alice', completion.id, 5, { kind: 'completion' })).toBe(true);
  expect(await env.DB.prepare('SELECT state, upload_id, completion_acknowledged FROM drive_upload_intents WHERE id = ?')
    .bind(completion.id).first()).toEqual({ state: 'acknowledged', upload_id: 'provider-id', completion_acknowledged: 1 });
  expect(await intents.get('bob', completion.id)).toBeNull();
  expect((await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results).toEqual(entriesBefore);
});

it('scans interrupted claims in bounded pages and quarantines without authorizing retries', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('recovery-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const first = await intents.create('recovery-owner');
  const second = await intents.create('recovery-owner');
  await intents.claim('recovery-owner', first.id, 0, 'allocation');
  await intents.claim('recovery-owner', second.id, 0, 'allocation');
  await expect(intents.listInFlight('', 0)).rejects.toThrow();
  await expect(intents.listInFlight('', 101)).rejects.toThrow();
  const page = await intents.listInFlight('', 1);
  expect(page).toHaveLength(1);
  const next = await intents.listInFlight(page[0].id, 1);
  expect(next).toHaveLength(1);
  expect(new Set([page[0].id, next[0].id])).toEqual(new Set([first.id, second.id]));
  expect(await intents.recordUncertain(page[0].owner_id, page[0].id, page[0].version, 'allocation')).toBe(true);
  expect(await intents.claim('recovery-owner', page[0].id, 2, 'allocation')).toBeNull();
  expect(await intents.recordNotDispatched(page[0].owner_id, page[0].id, page[0].version, 'allocation')).toBe(false);
  expect(await intents.recordSuccess(page[0].owner_id, page[0].id, page[0].version, { kind: 'allocation', uploadId: 'late' })).toBe(true);
  expect(await intents.get('recovery-owner', page[0].id)).toMatchObject({ state: 'allocated', upload_id: 'late' });
  expect(await intents.listInFlight('', 100)).toHaveLength(1);
});

it('rejects malformed outcomes and treats acknowledgements as terminal', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('terminal-owner', 'member', 'active')").run();
  const intents = new UploadIntents(env.DB);
  const intent = await intents.create('terminal-owner');
  await expect(intents.claim('terminal-owner', intent.id, Number.MAX_SAFE_INTEGER - 2, 'allocation')).rejects.toThrow();
  await expect(intents.claim('terminal-owner', intent.id, -1, 'allocation')).rejects.toThrow();
  await intents.claim('terminal-owner', intent.id, 0, 'allocation');
  await expect(intents.recordSuccess('terminal-owner', intent.id, 1, { kind: 'allocation', uploadId: '' })).rejects.toThrow();
  await intents.recordSuccess('terminal-owner', intent.id, 1, { kind: 'allocation', uploadId: 'id' });
  await intents.claim('terminal-owner', intent.id, 2, 'completion');
  expect(await intents.recordSuccess('terminal-owner', intent.id, 3, { kind: 'completion' })).toBe(true);
  expect(await intents.claim('terminal-owner', intent.id, 4, 'completion')).toBeNull();
  expect(await intents.recordUncertain('terminal-owner', intent.id, 3, 'completion')).toBe(false);
  expect(await intents.get('terminal-owner', intent.id)).toMatchObject({ state: 'acknowledged', version: 4 });
});
