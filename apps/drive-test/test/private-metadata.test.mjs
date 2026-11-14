import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';

it('initializes and reapplies the available actual migration directory', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const ledger = () => env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all();
  const initial = (await ledger()).results;
  expect(initial.filter(({ name }) => name === '0002_private_metadata.sql')).toHaveLength(1);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect((await ledger()).results).toEqual(initial);
  expect((await env.DB.prepare('PRAGMA table_info(drive_entries)').all()).results.map(({ name, type, notnull, pk }) => [name, type, notnull, pk]))
    .toEqual(expect.arrayContaining([['id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 0], ['parent_id', 'TEXT', 0, 0],
      ['name', 'TEXT', 1, 0], ['kind', 'TEXT', 1, 0], ['object_key', 'TEXT', 0, 0], ['size_bytes', 'INTEGER', 0, 0]]));
  expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).results.map(({ name }) => name))
    .toEqual(expect.arrayContaining(['drive_entries_immutable', 'drive_entries_insert_parent', 'drive_entries_move_parent']));
});

it('uses live test-only membership for private folder creation and lookup', async () => {
  // Test-only pre-metadata schema and data; not the production identity migration.
  await env.DB.exec(`CREATE TABLE test_members (id TEXT PRIMARY KEY, active INTEGER NOT NULL, role TEXT NOT NULL);
    CREATE VIEW drive_active_members AS SELECT id FROM test_members WHERE active = 1;`);
  await env.DB.prepare('INSERT INTO test_members VALUES (?, ?, ?), (?, ?, ?)')
    .bind('alice', 1, 'member', 'bob', 1, 'owner').run();
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect((await env.DB.prepare('SELECT * FROM test_members ORDER BY id').all()).results)
    .toEqual([{ id: 'alice', active: 1, role: 'member' }, { id: 'bob', active: 1, role: 'owner' }]);
  const metadata = new PrivateMetadata(env.DB);
  const folder = await metadata.createFolder('alice', null, 'private');
  expect(folder).toMatchObject({ owner_id: 'alice', parent_id: null, name: 'private', kind: 'folder' });
  expect(folder.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(await metadata.get('alice', folder.id)).toEqual(folder);
  expect(await metadata.get('bob', folder.id)).toBeNull();
  expect(await metadata.get('bob', 'missing')).toBeNull();
  const child = await metadata.createFolder('alice', folder.id, 'child');
  expect(await metadata.createFolder('alice', null, 'x'.repeat(255))).not.toBeNull();
  for (const name of ['', 'x'.repeat(256), '😀'.repeat(64), '..', ' . ', 'bad/name', 'bad\0name', '\ud800', '\udc00']) {
    await expect(metadata.createFolder('alice', null, name)).rejects.toThrow();
  }
  expect((await metadata.createFolder('alice', null, '😀'.repeat(63) + 'abc')).name).toBe('😀'.repeat(63) + 'abc');
  for (const name of ['😀'.repeat(64), '..', ' . ']) {
    await expect(env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES (?, 'alice', NULL, ?, 'folder', NULL, NULL)")
      .bind(crypto.randomUUID(), name).run()).rejects.toThrow();
  }
  await expect(metadata.createFolder('alice', null, 'private')).rejects.toThrow();
  await expect(metadata.createFolder('alice', folder.id, 'child')).rejects.toThrow();
  await expect(metadata.createFolder('alice', 'missing', 'child')).rejects.toThrow();
  await expect(metadata.createFolder('bob', folder.id, 'child')).rejects.toThrow();
  await env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES (?, ?, NULL, ?, 'file', ?, ?)")
    .bind('file', 'alice', 'file', 'object', 1).run();
  for (const size of [null, -1, 1.5, 9007199254740992]) {
    await expect(env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES (?, ?, NULL, ?, 'file', ?, ?)")
      .bind(`bad-${size}`, 'alice', `bad-${size}`, `key-${size}`, size).run()).rejects.toThrow();
  }
  await expect(env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES ('dup', 'alice', NULL, 'dup', 'file', 'object', 0)").run()).rejects.toThrow();
  await expect(env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES ('bad-folder', 'alice', NULL, 'bad-folder', 'folder', NULL, 0)").run()).rejects.toThrow();
  await expect(metadata.createFolder('alice', 'file', 'child')).rejects.toThrow();
  const beforeReplace = (await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results;
  const replace = env.DB.prepare('INSERT OR REPLACE INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const values of [
    [folder.id, 'alice', child.id, 'cycle', 'folder', null, null],
    [folder.id, 'bob', null, 'owned', 'folder', null, null],
    ['file', 'alice', null, 'file-changed', 'file', 'new-object', 1],
    ['new-file', 'alice', null, 'other', 'file', 'object', 1],
    ['new-folder', 'alice', null, 'private', 'folder', null, null],
  ]) {
    await expect(replace.bind(...values).run()).rejects.toThrow();
    expect((await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results).toEqual(beforeReplace);
  }
  for (const sql of [
    "UPDATE OR REPLACE drive_entries SET name = 'private' WHERE id = 'file'",
    "INSERT OR REPLACE INTO drive_entries (rowid, id, owner_id, name, kind) VALUES ((SELECT rowid FROM drive_entries WHERE id = 'file'), 'new', 'alice', 'new', 'folder')",
    `UPDATE OR REPLACE drive_entries SET rowid = (SELECT rowid FROM drive_entries WHERE id = 'file') WHERE id = '${child.id}'`,
  ]) {
    await expect(env.DB.prepare(sql).run()).rejects.toThrow();
    expect((await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results).toEqual(beforeReplace);
  }
  await replace.bind('ordinary', 'alice', child.id, 'ordinary', 'folder', null, null).run();
  expect((await env.DB.prepare('SELECT parent_id FROM drive_entries WHERE id = ?').bind('ordinary').first()).parent_id).toBe(child.id);
  for (const [column, value] of [['id', 'changed'], ['owner_id', 'bob'], ['kind', 'file'], ['object_key', 'changed']]) {
    await expect(env.DB.prepare(`UPDATE drive_entries SET ${column} = ? WHERE id = ?`)
      .bind(value, folder.id).run()).rejects.toThrow();
  }
  for (const parent of [folder.id, child.id]) {
    await expect(env.DB.prepare('UPDATE drive_entries SET parent_id = ? WHERE id = ?')
      .bind(parent, folder.id).run()).rejects.toThrow();
  }
  await expect(env.DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(folder.id).run()).rejects.toThrow();
  await expect(env.DB.batch([
    env.DB.prepare('UPDATE drive_entries SET name = ? WHERE id = ?').bind('renamed', folder.id),
    env.DB.prepare('UPDATE drive_entries SET parent_id = ? WHERE id = ?').bind(child.id, folder.id),
  ])).rejects.toThrow();
  expect(await metadata.get('alice', folder.id)).toEqual(folder);
  expect(await metadata.get('alice', child.id)).toEqual(child);
  expect(await metadata.createFolder('absent', null, 'no')).toBeNull();
  expect(await metadata.get('absent', folder.id)).toBeNull();
  await env.DB.prepare('UPDATE test_members SET active = 0 WHERE id = ?').bind('alice').run();
  expect(await metadata.get('alice', folder.id)).toBeNull();
  expect(await metadata.createFolder('alice', null, 'no')).toBeNull();
  expect((await env.DB.prepare("SELECT name FROM d1_migrations WHERE name = '0002_private_metadata.sql'").all()).results)
    .toEqual([{ name: '0002_private_metadata.sql' }]);
  expect((await env.DB.prepare('PRAGMA table_info(drive_entries)').all()).results
    .find((column) => column.name === 'size_bytes').type).toBe('INTEGER');
  await env.DB.exec('DROP VIEW drive_active_members');
  await expect(metadata.get('alice', folder.id)).rejects.toThrow();
  await expect(metadata.createFolder('alice', null, 'no')).rejects.toThrow();
});
