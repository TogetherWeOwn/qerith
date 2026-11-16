import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';

const run = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const rows = async (sql) => (await env.DB.prepare(sql).all()).results;
const file = (id, owner, size, parent = null) => run(
  'INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
  id, owner, parent, id, 'file', `key-${id}`, size,
);
const snapshot = async () => ({ entries: await rows('SELECT * FROM drive_entries ORDER BY id'),
  counts: await rows('SELECT * FROM drive_folder_counts ORDER BY folder_id'),
  usage: await rows('SELECT owner_id, CAST(high AS TEXT) AS high, low FROM drive_owner_usage ORDER BY owner_id') });

beforeEach(async () => {
  await env.DB.exec(`DROP TABLE IF EXISTS drive_sessions;
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
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name === '0001_identity.sql'));
  await env.DB.exec("INSERT INTO drive_principals VALUES ('alice', 'member', 'active'), ('bob', 'owner', 'active'), ('revoked', 'member', 'revoked')");
});

it('upgrades seeded entries exactly and enforces live owner membership', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name < '0004_private_owner_usage.sql'));
  await run("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('folder', 'alice', 'folder', 'folder')");
  await file('a', 'alice', 9007199254740991, 'folder');
  await file('b', 'alice', 9007199254740991, 'folder');
  await run(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 1025)
    INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes)
    SELECT 'large-' || i, 'alice', 'large-' || i, 'file', 'large-key-' || i, 9007199254740991 FROM n`);
  await file('other', 'bob', 17);
  const before = { entries: await rows('SELECT * FROM drive_entries ORDER BY id'), counts: await rows('SELECT * FROM drive_folder_counts ORDER BY folder_id') };
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const after = await snapshot();
  expect({ entries: after.entries, counts: after.counts }).toEqual(before);
  expect((await rows('SELECT name FROM d1_migrations ORDER BY id')).map(({ name }) => name))
    .toEqual(env.DRIVE_MIGRATIONS.map(({ name }) => name));
  const metadata = new PrivateMetadata(env.DB);
  expect(await metadata.usage('alice')).toEqual({ bytes: (1027n * 9007199254740991n).toString() });
  expect(await metadata.usage('bob')).toEqual({ bytes: '17' });
  expect(await metadata.usage('revoked')).toBeNull();
  expect(await metadata.usage('absent')).toBeNull();
  await run("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'");
  expect(await metadata.usage('alice')).toBeNull();
  await run("UPDATE drive_principals SET status = 'active' WHERE id = 'alice'");
  expect(await metadata.usage('alice')).toEqual({ bytes: (1027n * 9007199254740991n).toString() });
  await env.DB.exec('DROP VIEW drive_active_members');
  await expect(metadata.usage('alice')).rejects.toThrow();
});

it('rolls back a failed upgrade and retries without changing entries or counts', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name < '0004_private_owner_usage.sql'));
  await file('a', 'alice', 19);
  const entries = await rows('SELECT * FROM drive_entries ORDER BY id');
  const counts = await rows('SELECT * FROM drive_folder_counts ORDER BY folder_id');
  await env.DB.exec('CREATE TRIGGER drive_usage_insert AFTER INSERT ON drive_entries BEGIN SELECT 1; END;');
  await expect(applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS)).rejects.toThrow();
  expect(await rows('SELECT * FROM drive_entries ORDER BY id')).toEqual(entries);
  expect(await rows('SELECT * FROM drive_folder_counts ORDER BY folder_id')).toEqual(counts);
  expect(await rows("SELECT name FROM sqlite_master WHERE name IN ('drive_owner_usage', 'drive_usage_backfill')")).toEqual([]);
  expect((await rows('SELECT name FROM d1_migrations ORDER BY id')).map(({ name }) => name))
    .toEqual(['0001_identity.sql', '0002_private_metadata.sql', '0003_private_folder_counts.sql']);
  await env.DB.exec('DROP TRIGGER drive_usage_insert');
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  expect(await new PrivateMetadata(env.DB).usage('alice')).toEqual({ bytes: '19' });
});

it('accounts for insertion, resize, carry, borrow, zero and deletion', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const metadata = new PrivateMetadata(env.DB);
  expect(await metadata.usage('alice')).toEqual({ bytes: '0' });
  await file('a', 'alice', 1000000001);
  await file('b', 'alice', 999999999);
  expect(await metadata.usage('alice')).toEqual({ bytes: '2000000000' });
  await run('UPDATE drive_entries SET size_bytes = ? WHERE id = ?', 1, 'a');
  expect(await metadata.usage('alice')).toEqual({ bytes: '1000000000' });
  await run('DELETE FROM drive_entries WHERE id = ?', 'b');
  expect(await metadata.usage('alice')).toEqual({ bytes: '1' });
  await run('UPDATE drive_entries SET size_bytes = 0 WHERE id = ?', 'a');
  await run('DELETE FROM drive_entries WHERE id = ?', 'a');
  expect(await metadata.usage('alice')).toEqual({ bytes: '0' });
});

it('rolls back maximum-limb overflow, missing counters and batched failures', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await file('a', 'alice', 1);
  await run('UPDATE drive_owner_usage SET high = ?, low = ? WHERE owner_id = ?', 9007199254740991, 999999998, 'alice');
  await run('UPDATE drive_entries SET size_bytes = 2 WHERE id = ?', 'a');
  const metadata = new PrivateMetadata(env.DB);
  expect(await metadata.usage('alice')).toEqual({ bytes: '9007199254740991999999999' });
  const unchanged = async (operation) => {
    const before = await snapshot();
    await expect(operation()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  };
  await unchanged(() => run('UPDATE drive_entries SET size_bytes = 3 WHERE id = ?', 'a'));
  await unchanged(() => run('UPDATE OR IGNORE drive_entries SET size_bytes = 3 WHERE id = ?', 'a'));
  await unchanged(() => file('overflow', 'alice', 1));
  await file('zero', 'alice', 0);
  await run('UPDATE drive_entries SET size_bytes = 1 WHERE id = ?', 'a');
  expect(await metadata.usage('alice')).toEqual({ bytes: '9007199254740991999999998' });
  await unchanged(() => env.DB.batch([
    env.DB.prepare('UPDATE drive_entries SET size_bytes = 0 WHERE id = ?').bind('a'),
    env.DB.prepare('INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, ?, ?)').bind('a', 'alice', 'a', 'folder'),
  ]));
  await run('UPDATE drive_owner_usage SET high = 0, low = 0 WHERE owner_id = ?', 'alice');
  await unchanged(() => run('DELETE FROM drive_entries WHERE id = ?', 'a'));
  await unchanged(() => run('UPDATE drive_entries SET size_bytes = 0 WHERE id = ?', 'a'));
  await run('DELETE FROM drive_owner_usage WHERE owner_id = ?', 'alice');
  await unchanged(() => run('DELETE FROM drive_entries WHERE id = ?', 'a'));
  await unchanged(() => run('UPDATE drive_entries SET size_bytes = 0 WHERE id = ?', 'a'));
});
