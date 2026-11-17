import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const migration = '0017_upload_key_reservations.sql';
const insert = (id, owner, key, policy = '') => env.DB.prepare(`INSERT ${policy} INTO drive_upload_intents
  (id, owner_id, object_key, state) VALUES (?, ?, ?, 'created')`).bind(id, owner, key).run();
const keys = async () => (await env.DB.prepare('SELECT object_key FROM drive_upload_key_reservations ORDER BY object_key').all()).results;

it('backfills existing keys and permanently reserves new keys across deletion', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name < migration));
  await insert('old', 'alice', 'old-key');
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect(await keys()).toEqual([{ object_key: 'old-key' }]);
  await insert('new', 'bob', 'new-key');
  await env.DB.prepare("DELETE FROM drive_upload_intents WHERE id IN ('old', 'new')").run();
  for (const policy of ['', 'OR IGNORE', 'OR REPLACE', 'OR FAIL', 'OR ROLLBACK']) {
    await expect(insert('retry', 'another-owner', 'old-key', policy)).rejects.toThrow();
    await expect(insert('retry', 'another-owner', 'new-key', policy)).rejects.toThrow();
  }
  expect(await keys()).toEqual([{ object_key: 'new-key' }, { object_key: 'old-key' }]);
  expect((await env.DB.prepare('SELECT id FROM drive_upload_intents').all()).results).toEqual([]);
});

it('rejects identity mutations and conflict-policy replacement without losing evidence', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await insert('intent', 'alice', 'key');
  for (const column of ['id', 'owner_id', 'object_key']) {
    for (const policy of ['', 'OR IGNORE', 'OR REPLACE', 'OR FAIL', 'OR ROLLBACK']) {
      await expect(env.DB.prepare(`UPDATE ${policy} drive_upload_intents SET ${column} = 'changed' WHERE id = 'intent'`).run()).rejects.toThrow();
    }
  }
  for (const policy of ['', 'OR IGNORE', 'OR REPLACE', 'OR FAIL', 'OR ROLLBACK']) {
    await expect(insert('intent', 'bob', 'different-key', policy)).rejects.toThrow();
    await expect(env.DB.prepare(`INSERT ${policy} INTO drive_upload_key_reservations VALUES ('key')`).run()).rejects.toThrow();
    await expect(env.DB.prepare(`UPDATE ${policy} drive_upload_key_reservations SET object_key = 'changed'`).run()).rejects.toThrow();
  }
  await expect(env.DB.prepare("DELETE FROM drive_upload_key_reservations WHERE object_key = 'key'").run()).rejects.toThrow();
  await expect(env.DB.prepare("INSERT INTO drive_upload_intents (id, owner_id, object_key, state) VALUES ('intent', 'bob', 'key', 'created') ON CONFLICT(id) DO UPDATE SET object_key = 'different-key'").run()).rejects.toThrow();
  expect(await env.DB.prepare("SELECT id, owner_id, object_key FROM drive_upload_intents WHERE id = 'intent'").first())
    .toEqual({ id: 'intent', owner_id: 'alice', object_key: 'key' });
  expect(await keys()).toEqual([{ object_key: 'key' }]);
  await env.DB.prepare("UPDATE drive_upload_intents SET state = 'initiating' WHERE id = 'intent'").run();
});

it('does not reserve a key when the journal insert fails', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await expect(env.DB.prepare("INSERT INTO drive_upload_intents (id, owner_id, object_key, state) VALUES ('bad', 'alice', 'unused', 'invalid')").run()).rejects.toThrow();
  expect(await keys()).toEqual([]);
  await insert('good', 'alice', 'unused');
  await expect(env.DB.prepare(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state) VALUES
    ('first', 'alice', 'fresh', 'created'), ('second', 'alice', 'unused', 'created')`).run()).rejects.toThrow();
  expect(await keys()).toEqual([{ object_key: 'unused' }]);
  expect(await env.DB.prepare("SELECT id FROM drive_upload_intents WHERE id = 'first'").first()).toBeNull();
});
