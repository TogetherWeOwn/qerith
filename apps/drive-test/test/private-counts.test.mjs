import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';

const run = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const rows = async (sql) => (await env.DB.prepare(sql).all()).results;
const insert = (id, parent = null, kind = 'folder', owner = 'alice') => run(
  'INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
  id, owner, parent, id, kind, kind === 'file' ? `key-${id}` : null, kind === 'file' ? 0 : null,
);
const snapshot = async () => ({ entries: await rows('SELECT * FROM drive_entries ORDER BY id'),
  counts: await rows('SELECT * FROM drive_folder_counts ORDER BY folder_id') });

beforeEach(async () => {
  // D1 state is shared between tests in this file; reset the migration ledger too.
  await env.DB.exec(`DROP TRIGGER IF EXISTS drive_counts_insert;
    DROP TRIGGER IF EXISTS drive_counts_move;
    DROP TRIGGER IF EXISTS drive_counts_delete;
    DROP TABLE IF EXISTS drive_folder_counts;
    DROP TABLE IF EXISTS drive_entries;
    DROP TABLE IF EXISTS drive_owner_usage;
    DROP TABLE IF EXISTS d1_migrations;
    DROP VIEW IF EXISTS drive_active_members;
    DROP TABLE IF EXISTS test_members;
    CREATE TABLE test_members (id TEXT PRIMARY KEY, active INTEGER NOT NULL);
    CREATE VIEW drive_active_members AS SELECT id FROM test_members WHERE active = 1;
    INSERT INTO test_members VALUES ('alice', 1), ('bob', 1);`);
});

it('upgrades seeded entries and maintains direct counts through mutations', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name === '0002_private_metadata.sql'));
  await insert('a'); await insert('b'); await insert('nested', 'a');
  await insert('file', 'nested', 'file'); await insert('foreign', null, 'folder', 'bob');
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect((await rows('SELECT name FROM d1_migrations ORDER BY id')).map(({ name }) => name))
    .toEqual(['0002_private_metadata.sql', '0003_private_folder_counts.sql', '0004_private_owner_usage.sql']);
  const metadata = new PrivateMetadata(env.DB);
  const root = () => metadata.list('alice', null);
  expect((await root()).entries.map(({ id, item_count }) => [id, item_count])).toEqual([['a', 1], ['b', 0]]);
  expect((await metadata.list('alice', 'nested')).entries[0]).toMatchObject({ id: 'file', item_count: null });
  expect((await metadata.list('bob', null)).entries).toMatchObject([{ id: 'foreign', item_count: 0 }]);
  expect((await metadata.list('absent', null)).entries).toEqual([]);
  await insert('new', 'a', 'file');
  await metadata.move('alice', 'nested', 'b', 'nested');
  expect((await root()).entries.map(({ id, item_count }) => [id, item_count])).toEqual([['a', 1], ['b', 1]]);
  await run('DELETE FROM drive_entries WHERE id = ?', 'new');
  await insert('empty', 'a');
  await run('DELETE FROM drive_entries WHERE id = ?', 'empty');
  expect(await rows("SELECT folder_id FROM drive_folder_counts WHERE folder_id = 'empty'")).toEqual([]);
  await metadata.move('alice', 'nested', null, 'nested');
  expect((await root()).entries.map(({ id, item_count }) => [id, item_count])).toEqual([['a', 0], ['b', 0], ['nested', 1]]);
  await run('UPDATE test_members SET active = 0 WHERE id = ?', 'alice');
  expect((await root()).entries).toEqual([]);
});

it('rolls back a failed migration and can retry without changing seeded entries', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name === '0002_private_metadata.sql'));
  await insert('a'); await insert('child', 'a');
  const before = await rows('SELECT * FROM drive_entries ORDER BY id');
  await env.DB.exec('CREATE TRIGGER drive_counts_move AFTER UPDATE ON drive_entries BEGIN SELECT 1; END;');
  await expect(applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS)).rejects.toThrow();
  expect(await rows('SELECT * FROM drive_entries ORDER BY id')).toEqual(before);
  expect(await rows("SELECT name FROM sqlite_master WHERE name IN ('drive_folder_counts', 'drive_counts_insert')")).toEqual([]);
  expect((await rows('SELECT name FROM d1_migrations')).map(({ name }) => name)).toEqual(['0002_private_metadata.sql']);
  await env.DB.exec('DROP TRIGGER drive_counts_move');
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect(await rows('SELECT * FROM drive_folder_counts ORDER BY folder_id'))
    .toEqual([{ folder_id: 'a', item_count: 1 }, { folder_id: 'child', item_count: 0 }]);
});

it('rolls back entries and both counts on overflow, underflow and invalid writes', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await insert('a'); await insert('b'); await insert('child', 'a');
  const unchanged = async (operation) => {
    const before = await snapshot();
    await expect(operation()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  };
  await run('UPDATE drive_folder_counts SET item_count = ? WHERE folder_id = ?', 9007199254740991, 'b');
  await unchanged(() => insert('overflow', 'b'));
  await unchanged(() => run('UPDATE drive_entries SET parent_id = ? WHERE id = ?', 'b', 'child'));
  await run('UPDATE drive_folder_counts SET item_count = 0 WHERE folder_id IN (?, ?)', 'a', 'b');
  await unchanged(() => run('DELETE FROM drive_entries WHERE id = ?', 'child'));
  await unchanged(() => run('UPDATE drive_entries SET parent_id = ? WHERE id = ?', 'b', 'child'));
  await run('UPDATE drive_folder_counts SET item_count = 1 WHERE folder_id = ?', 'a');
  await unchanged(() => insert('child', 'b'));
  await unchanged(() => insert('bad', 'missing'));
  await unchanged(() => run('UPDATE drive_entries SET parent_id = ? WHERE id = ?', 'child', 'a'));
  await unchanged(() => run('DELETE FROM drive_entries WHERE id = ?', 'a'));
  await unchanged(() => env.DB.batch([
    env.DB.prepare('UPDATE drive_entries SET parent_id = ? WHERE id = ?').bind('b', 'child'),
    env.DB.prepare('INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, ?, ?)').bind('child', 'alice', 'child', 'folder'),
  ]));
});
