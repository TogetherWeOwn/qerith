import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const migration = '0018_upload_intent_identity_reservations.sql';
const run = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const rows = async (sql) => (await env.DB.prepare(sql).all()).results;
const identities = () => rows('SELECT intent_id, owner_id, object_key FROM drive_upload_intent_reservations ORDER BY intent_id');
const insert = (id, owner, key, policy = '') => run(`INSERT ${policy} INTO drive_upload_intents
  (id, owner_id, object_key, state) VALUES (?, ?, ?, 'created')`, id, owner, key);

it('upgrades surviving intents and permanently reserves their identity and new identities', async () => {
  const throughIdentity = env.DRIVE_MIGRATIONS.filter(({ name }) => name <= migration);
  await applyD1Migrations(env.DB, throughIdentity.filter(({ name }) => name < migration));
  await insert('surviving', 'alice', 'surviving-key');
  await run(`UPDATE drive_upload_intents SET state = 'acknowledged', upload_id = 'legacy-upload',
    version = 4, completion_acknowledged = 1 WHERE id = 'surviving'`);
  await insert('legacy-deleted', 'alice', 'legacy-key');
  await run("DELETE FROM drive_upload_intents WHERE id = 'legacy-deleted'");
  const before = await rows('SELECT * FROM drive_upload_intents');
  await applyD1Migrations(env.DB, throughIdentity);
  await applyD1Migrations(env.DB, throughIdentity);
  expect(await rows('SELECT name FROM d1_migrations ORDER BY id')).toEqual(throughIdentity.map(({ name }) => ({ name })));
  expect(await rows('SELECT * FROM drive_upload_intents')).toEqual(before);
  const surviving = { intent_id: 'surviving', owner_id: 'alice', object_key: 'surviving-key' };
  expect(await identities()).toEqual([surviving]);

  await insert('new', 'bob', 'new-key');
  await run("UPDATE drive_upload_intents SET state = 'initiating', version = 1 WHERE id = 'new'");
  await run('DELETE FROM drive_upload_intents');
  for (const policy of ['', 'OR ABORT', 'OR IGNORE', 'OR REPLACE', 'OR FAIL', 'OR ROLLBACK']) {
    for (const id of ['surviving', 'new']) {
      await expect(insert(id, 'another-owner', 'other-key', policy)).rejects.toThrow('upload intent ID already reserved');
    }
    await expect(run(`INSERT ${policy} INTO drive_upload_intent_reservations VALUES ('legacy-deleted', 'alice', 'legacy-key')`))
      .rejects.toThrow('cannot reserve upload intent identity');
    await expect(run(`INSERT ${policy} INTO drive_upload_intent_reservations VALUES ('new', 'bob', 'new-key')`))
      .rejects.toThrow('cannot reserve upload intent identity');
    await expect(run(`UPDATE ${policy} drive_upload_intent_reservations SET owner_id = 'another-owner' WHERE intent_id = 'new'`))
      .rejects.toThrow('upload intent reservations are immutable');
  }
  await expect(insert('different', 'bob', 'legacy-key')).rejects.toThrow('upload identity already used');
  await expect(run('DELETE FROM drive_upload_intent_reservations')).rejects.toThrow('upload intent reservations are permanent');
  await expect(run(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state)
    VALUES ('new', 'bob', 'other-key', 'created') ON CONFLICT(id) DO NOTHING`)).rejects.toThrow('upload intent ID already reserved');
  await expect(run(`INSERT OR FAIL INTO drive_upload_intents (id, owner_id, object_key, state) VALUES
    ('first', 'alice', 'first-key', 'created'), ('new', 'bob', 'other-key', 'created')`)).rejects.toThrow('upload intent ID already reserved');
  expect(await rows('SELECT id FROM drive_upload_intents')).toEqual([]);
  expect(await identities()).toEqual([{ intent_id: 'new', owner_id: 'bob', object_key: 'new-key' }, surviving]);
  expect(await rows('SELECT object_key FROM drive_upload_key_reservations ORDER BY object_key'))
    .toEqual(['legacy-key', 'new-key', 'surviving-key'].map((object_key) => ({ object_key })));
});
