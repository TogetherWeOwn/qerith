import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';
import { findActivePrincipal } from '../../drive/src/lib/server/identity/membership.ts';

beforeEach(async () => {
  // D1 state is shared between tests in this file; reset the migration ledger too.
  await env.DB.exec(`DROP TABLE IF EXISTS drive_upload_completion_evidence;
    DROP TABLE IF EXISTS drive_upload_completion_operations;
    DROP TABLE IF EXISTS drive_upload_intents;
    DROP TABLE IF EXISTS drive_upload_intent_reservations;
    DROP TABLE IF EXISTS drive_upload_key_reservations;
    DROP TABLE IF EXISTS drive_read_grants;
    DROP TABLE IF EXISTS drive_recovery_tokens;
    DROP TABLE IF EXISTS drive_login_generations;
    DROP TABLE IF EXISTS drive_sessions;
    DROP TABLE IF EXISTS drive_folder_counts;
    DROP TABLE IF EXISTS drive_entries;
    DROP TABLE IF EXISTS drive_owner_usage;
    DROP TABLE IF EXISTS drive_webauthn_challenges;
    DROP TABLE IF EXISTS drive_bound_ceremonies;
    DROP TABLE IF EXISTS drive_credentials;
    DROP TABLE IF EXISTS drive_invitations;
    DROP TABLE IF EXISTS d1_migrations;
    DROP VIEW IF EXISTS drive_active_members;
    DROP TABLE IF EXISTS drive_principals;`);
});

it('initializes and reapplies the available actual migration directory', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const ledger = () => env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all();
  const initial = (await ledger()).results;
  expect(initial.map(({ name }) => name)).toEqual(env.DRIVE_MIGRATIONS.map(({ name }) => name));
  expect(new Set(initial.map(({ name }) => name)).size).toBe(env.DRIVE_MIGRATIONS.length);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect((await ledger()).results).toEqual(initial);
  expect((await env.DB.prepare('PRAGMA table_info(drive_entries)').all()).results.map(({ name, type, notnull, pk }) => [name, type, notnull, pk]))
    .toEqual(expect.arrayContaining([['id', 'TEXT', 1, 1], ['owner_id', 'TEXT', 1, 0], ['parent_id', 'TEXT', 0, 0],
      ['name', 'TEXT', 1, 0], ['kind', 'TEXT', 1, 0], ['object_key', 'TEXT', 0, 0], ['size_bytes', 'INTEGER', 0, 0]]));
  expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).results.map(({ name }) => name))
    .toEqual(expect.arrayContaining(['drive_entries_immutable', 'drive_entries_insert_parent', 'drive_entries_move_parent']));
});

it('upgrades seeded actual identity and uses live membership for private metadata', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name === '0001_identity.sql'));
  await env.DB.prepare('INSERT INTO drive_principals VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)')
    .bind('alice', 'member', 'active', 'bob', 'owner', 'active', 'revoked', 'member', 'revoked').run();
  const principals = (await env.DB.prepare('SELECT * FROM drive_principals ORDER BY id').all()).results;
  const beforeLedger = (await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results;
  expect(beforeLedger).toEqual([{ name: '0001_identity.sql' }]);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect((await env.DB.prepare('SELECT * FROM drive_principals ORDER BY id').all()).results).toEqual(principals);
  expect((await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results.map(({ name }) => name))
    .toEqual(env.DRIVE_MIGRATIONS.map(({ name }) => name));
  expect(await findActivePrincipal(env.DB, 'alice')).toEqual({ id: 'alice', role: 'member' });
  expect(await findActivePrincipal(env.DB, 'bob')).toEqual({ id: 'bob', role: 'owner' });
  expect(await findActivePrincipal(env.DB, 'absent')).toBeNull();
  expect(await findActivePrincipal(env.DB, 'revoked')).toBeNull();
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
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = ?").bind('alice').run();
  expect(await findActivePrincipal(env.DB, 'alice')).toBeNull();
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

it('enforces principal constraints and propagates lookup failures', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const insert = env.DB.prepare('INSERT INTO drive_principals (id, role, status) VALUES (?, ?, ?)');
  await insert.bind('owner', 'owner', 'revoked').run();
  for (const values of [
    ['', 'member', 'active'], [null, 'member', 'active'], ['bad-role', 'admin', 'active'],
    ['bad-status', 'member', 'pending'], ['null-role', null, 'active'], ['null-status', 'member', null], ['second-owner', 'owner', 'active'],
    ['owner', 'member', 'active'],
  ]) await expect(insert.bind(...values).run()).rejects.toThrow();
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'owner'").run();
  expect(await findActivePrincipal(env.DB, 'owner')).toEqual({ id: 'owner', role: 'owner' });
  await env.DB.exec('DROP VIEW drive_active_members; DROP TABLE drive_principals;');
  await expect(findActivePrincipal(env.DB, 'owner')).rejects.toThrow();
});
