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

it('creates private intents only for active members and isolates owners', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.prepare('INSERT INTO drive_principals VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
    .bind('alice', 'member', 'active', 'bob', 'member', 'active', 'revoked', 'member', 'revoked').run();
  const entriesBefore = (await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results;
  const intentsBefore = (await env.DB.prepare('SELECT id FROM drive_upload_intents').all()).results;
  const intents = new UploadIntents(env.DB);
  expect(await intents.create('revoked')).toBeNull();
  expect(await intents.create('missing')).toBeNull();
  const intent = await intents.create('alice');
  expect(intent).toMatchObject({ owner_id: 'alice', state: 'created', version: 0, upload_id: null, completion_acknowledged: 0 });
  expect(intent.id).toBeTruthy();
  expect(intent.object_key).toBeTruthy();
  expect(await intents.get('alice', intent.id)).toEqual(intent);
  expect(await intents.get('bob', intent.id)).toBeNull();
  expect(await intents.get('alice', 'missing')).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  expect(await intents.get('alice', intent.id)).toBeNull();
  expect(await intents.create('alice')).toBeNull();
  const intentsAfter = (await env.DB.prepare('SELECT id FROM drive_upload_intents').all()).results;
  expect(intentsAfter).toEqual(expect.arrayContaining([...intentsBefore, { id: intent.id }]));
  expect(intentsAfter).toHaveLength(intentsBefore.length + 1);
  expect((await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results).toEqual(entriesBefore);
});
