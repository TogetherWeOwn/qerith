import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';

it('uses live test-only membership for private folder creation and lookup', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  // Test-only stand-in, not the production identity integration.
  await env.DB.exec(`CREATE TABLE test_members (id TEXT PRIMARY KEY, active INTEGER NOT NULL, role TEXT NOT NULL);
    CREATE VIEW drive_active_members AS SELECT id FROM test_members WHERE active = 1;`);
  await env.DB.prepare('INSERT INTO test_members VALUES (?, ?, ?), (?, ?, ?)')
    .bind('alice', 1, 'member', 'bob', 1, 'owner').run();
  const metadata = new PrivateMetadata(env.DB);
  const folder = await metadata.createFolder('alice', null, 'private');
  expect(folder).toMatchObject({ owner_id: 'alice', parent_id: null, name: 'private', kind: 'folder' });
  expect(folder.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(await metadata.get('alice', folder.id)).toEqual(folder);
  expect(await metadata.get('bob', folder.id)).toBeNull();
  expect(await metadata.get('bob', 'missing')).toBeNull();
  const child = await metadata.createFolder('alice', folder.id, 'child');
  expect(await metadata.createFolder('alice', null, 'x'.repeat(255))).not.toBeNull();
  for (const name of ['', 'x'.repeat(256), 'bad/name', 'bad\0name']) {
    await expect(metadata.createFolder('alice', null, name)).rejects.toThrow();
  }
  await expect(metadata.createFolder('alice', null, 'private')).rejects.toThrow();
  await expect(metadata.createFolder('alice', folder.id, 'child')).rejects.toThrow();
  await expect(metadata.createFolder('alice', 'missing', 'child')).rejects.toThrow();
  await expect(metadata.createFolder('bob', folder.id, 'child')).rejects.toThrow();
  await env.DB.prepare("INSERT INTO drive_entries VALUES (?, ?, NULL, ?, 'file', ?, ?)")
    .bind('file', 'alice', 'file', 'object', 1).run();
  for (const size of [null, -1, 1.5, 9007199254740992]) {
    await expect(env.DB.prepare("INSERT INTO drive_entries VALUES (?, ?, NULL, ?, 'file', ?, ?)")
      .bind(`bad-${size}`, 'alice', `bad-${size}`, `key-${size}`, size).run()).rejects.toThrow();
  }
  await expect(env.DB.prepare("INSERT INTO drive_entries VALUES ('dup', 'alice', NULL, 'dup', 'file', 'object', 0)").run()).rejects.toThrow();
  await expect(env.DB.prepare("INSERT INTO drive_entries VALUES ('bad-folder', 'alice', NULL, 'bad-folder', 'folder', NULL, 0)").run()).rejects.toThrow();
  await expect(metadata.createFolder('alice', 'file', 'child')).rejects.toThrow();
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
  expect((await env.DB.prepare('SELECT name FROM d1_migrations').all()).results)
    .toEqual([{ name: '0002_private_metadata.sql' }]);
  expect((await env.DB.prepare('PRAGMA table_info(drive_entries)').all()).results
    .find((column) => column.name === 'size_bytes').type).toBe('INTEGER');
  await env.DB.exec('DROP VIEW drive_active_members');
  await expect(metadata.get('alice', folder.id)).rejects.toThrow();
  await expect(metadata.createFolder('alice', null, 'no')).rejects.toThrow();
});
