import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';

const migration = '0024_upload_intent_declared_size.sql';
const run = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const count = async (table) => (await env.DB.prepare(`SELECT count(*) AS count FROM ${table}`).first()).count;

async function setup(owner) {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await run("INSERT INTO drive_principals VALUES (?, 'member', 'active')", owner);
  return new UploadIntents(env.DB);
}

it('preserves legacy rows at NULL and prevents setting, changing, or clearing a declaration', async () => {
  const owner = 'legacy-owner';
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name < migration));
  await run(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state)
    VALUES ('legacy', ?, 'legacy-key', 'created')`, owner);
  const before = await env.DB.prepare("SELECT * FROM drive_upload_intents WHERE id = 'legacy'").first();
  expect(before).not.toHaveProperty('declared_size');
  const intents = await setup(owner);
  expect(await intents.get(owner, 'legacy')).toEqual({ ...before, declared_size: null });
  expect(await intents.create(owner)).toMatchObject({ state: 'created', declared_size: null });
  const sized = await intents.createSized(owner, 0);
  for (const [id, size] of [['legacy', 0], [sized.id, 1], [sized.id, null]]) {
    await expect(run('UPDATE OR IGNORE drive_upload_intents SET declared_size = ? WHERE id = ?', size, id))
      .rejects.toThrow('declared upload size is immutable');
  }
  await expect(run(`INSERT OR REPLACE INTO drive_upload_intents (id, owner_id, object_key, state, declared_size)
    VALUES (?, ?, 'replacement-key', 'created', 1)`, sized.id, owner)).rejects.toThrow();
  expect((await intents.get(owner, sized.id)).declared_size).toBe(0);
  expect((await intents.get(owner, 'legacy')).declared_size).toBeNull();
});

it('creates sized intents only for live members and returns size through owner reads and claims', async () => {
  const owner = 'sized-owner';
  const intents = await setup(owner);
  const before = await count('drive_upload_intents');
  await run("INSERT INTO drive_principals VALUES ('other-member', 'member', 'active')");
  for (const size of [0, 16, Number.MAX_SAFE_INTEGER]) {
    const intent = await intents.createSized(owner, size);
    expect(intent).toMatchObject({ owner_id: owner, declared_size: size, state: 'created', version: 0 });
    expect(await intents.get(owner, intent.id)).toEqual(intent);
    expect(await intents.get('other-member', intent.id)).toBeNull();
    expect(await intents.claim(owner, intent.id, 0, 'allocation'))
      .toMatchObject({ declared_size: size, state: 'initiating', version: 1 });
  }
  await run("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", owner);
  expect(await intents.createSized(owner, 16)).toBeNull();
  expect(await intents.createSized('missing-member', 16)).toBeNull();
  expect(await count('drive_upload_intents')).toBe(before + 3);
});

it('rejects invalid declarations before inserting and constrains direct writes', async () => {
  const owner = 'invalid-size-owner';
  const intents = await setup(owner);
  const before = await count('drive_upload_intent_reservations');
  for (const size of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined, true]) {
    await expect(intents.createSized(owner, size)).rejects.toThrow('Invalid declared upload size');
  }
  for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'invalid']) {
    await expect(run(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size)
      VALUES ('invalid-size', ?, 'invalid-key', 'created', ?)`, owner, size)).rejects.toThrow('CHECK constraint failed');
  }
  expect(await count('drive_upload_intent_reservations')).toBe(before);
});
