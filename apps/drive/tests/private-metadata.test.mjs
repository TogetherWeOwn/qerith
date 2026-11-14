import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrivateMetadata } from '../src/lib/server/metadata/private.ts';

function setup() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE members (id TEXT PRIMARY KEY, active INTEGER NOT NULL);
    CREATE VIEW drive_active_members AS SELECT id FROM members WHERE active = 1;
    INSERT INTO members VALUES ('alice', 1), ('bob', 1), ('revoked', 0);`);
  sql.exec(readFileSync(new URL('../migrations/0002_private_metadata.sql', import.meta.url), 'utf8'));
  const db = { prepare(query) {
    return { bind(...args) {
      return {
        async first() { return sql.prepare(query).get(...args) ?? null; },
        async all() { return { results: sql.prepare(query).all(...args) }; },
      };
    } };
  } };
  return { sql, service: new PrivateMetadata(db) };
}

test('private entries require live membership for each operation', async () => {
  const { sql, service } = setup();
  const entry = await service.createFolder('alice', null, 'Documents');
  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  assert.equal(await service.get('bob', entry.id), null);
  assert.equal(await service.get('bob', 'missing'), null);
  assert.equal(await service.move('bob', entry.id, null, 'stolen'), null);
  assert.deepEqual(await service.list('bob', null), { entries: [], nextCursor: null });
  assert.equal(await service.createFolder('revoked', null, 'No'), null);
  sql.exec("UPDATE members SET active = 0 WHERE id = 'alice'");
  assert.equal(await service.get('alice', entry.id), null);
  assert.deepEqual(await service.list('alice', null), { entries: [], nextCursor: null });
  assert.equal(await service.move('alice', entry.id, null, 'No'), null);
  sql.exec("UPDATE members SET active = 1 WHERE id = 'alice'");
  assert.equal((await service.get('alice', entry.id)).name, 'Documents');
});

test('sibling uniqueness and parent ownership apply on create and move', async () => {
  const { service } = setup();
  const a = await service.createFolder('alice', null, 'A');
  const b = await service.createFolder('alice', null, 'B');
  const c = await service.createFolder('bob', null, 'A');
  await assert.rejects(service.createFolder('alice', null, 'A'));
  await assert.rejects(service.createFolder('alice', c.id, 'child'));
  await assert.rejects(service.move('alice', b.id, null, 'A'));
  assert.ok(await service.move('alice', b.id, a.id, 'B'));
  await assert.rejects(service.move('alice', b.id, c.id, 'B'));
});

test('cycles and object identity changes are rejected without copying bytes', async () => {
  const { sql, service } = setup();
  const a = await service.createFolder('alice', null, 'A');
  const b = await service.createFolder('alice', a.id, 'B');
  const c = await service.createFolder('alice', b.id, 'C');
  await assert.rejects(service.move('alice', a.id, c.id, 'A'));
  await assert.rejects(service.move('alice', a.id, a.id, 'A'));
  sql.prepare("INSERT INTO drive_entries VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run('f', 'alice', a.id, 'file', 'file', 'opaque-key', 12);
  assert.ok(await service.move('alice', 'f', b.id, 'renamed'));
  assert.equal(sql.prepare("SELECT object_key FROM drive_entries WHERE id = 'f'").get().object_key, 'opaque-key');
  assert.throws(() => sql.exec("UPDATE drive_entries SET object_key = 'other' WHERE id = 'f'"));
  await assert.rejects(service.createFolder('alice', 'f', 'child'));
});

test('listing is bounded and continues without crossing owners', async () => {
  const { service } = setup();
  for (let i = 0; i < 105; i++) {
    await service.createFolder('alice', null, `entry-${String(i).padStart(3, '0')}`);
  }
  await service.createFolder('bob', null, 'entry-101');
  const first = await service.list('alice', null);
  assert.equal(first.entries.length, 100);
  assert.ok(first.nextCursor);
  const second = await service.list('alice', null, first.nextCursor);
  assert.equal(second.entries.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size, 105);
  assert.ok(second.entries.every(entry => entry.owner_id === 'alice'));
});

test('folder listings count direct items only and follow membership and moves', async () => {
  const { sql, service } = setup();
  const a = await service.createFolder('alice', null, 'A');
  const b = await service.createFolder('alice', a.id, 'B');
  await service.createFolder('alice', b.id, 'nested');
  sql.prepare('INSERT INTO drive_entries VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('f', 'alice', a.id, 'file', 'file', 'file-key', 3);
  const root = await service.list('alice', null);
  assert.equal(root.entries[0].item_count, 2);
  const children = await service.list('alice', a.id);
  assert.equal(children.entries.find(entry => entry.id === b.id).item_count, 1);
  assert.equal(children.entries.find(entry => entry.id === 'f').item_count, null);
  await service.move('alice', 'f', null, 'file');
  assert.equal((await service.list('alice', null)).entries[0].item_count, 1);
  assert.deepEqual(await service.list('bob', a.id), { entries: [], nextCursor: null });
  sql.exec("UPDATE members SET active = 0 WHERE id = 'alice'");
  assert.deepEqual(await service.list('alice', null), { entries: [], nextCursor: null });
});

test('usage reflects only the active owner’s completed files', async () => {
  const { sql, service } = setup();
  const insert = sql.prepare('INSERT INTO drive_entries VALUES (?, ?, NULL, ?, ?, ?, ?)');
  await service.createFolder('alice', null, 'folder');
  insert.run('a', 'alice', 'one', 'file', 'key-a', 12);
  insert.run('b', 'bob', 'other', 'file', 'key-b', 99);
  assert.deepEqual({ ...await service.usage('alice') }, { bytes: '12' });
  assert.deepEqual({ ...await service.usage('bob') }, { bytes: '99' });
  assert.equal(await service.usage('revoked'), null);
  sql.exec("UPDATE drive_entries SET size_bytes = 23 WHERE id = 'a'");
  assert.equal((await service.usage('alice')).bytes, '23');
  sql.exec("UPDATE members SET active = 0 WHERE id = 'alice'");
  assert.equal(await service.usage('alice'), null);
  sql.exec("UPDATE members SET active = 1 WHERE id = 'alice'");
  assert.equal((await service.usage('alice')).bytes, '23');
  sql.exec("DELETE FROM drive_entries WHERE id = 'a'");
  assert.equal((await service.usage('alice')).bytes, '0');
  assert.throws(() => insert.run('bad', 'alice', 'bad', 'file', 'key-bad', null));
});

test('entry names are bounded on create and move', async () => {
  const { service } = setup();
  const entry = await service.createFolder('alice', null, 'a'.repeat(255));
  for (const name of ['', 'a'.repeat(256), 'bad/name', 'bad\0name']) {
    await assert.rejects(service.createFolder('alice', null, name), /Invalid entry name/);
    await assert.rejects(service.move('alice', entry.id, null, name), /Invalid entry name/);
  }
});

test('database failures are not reported as missing entries', async () => {
  const { sql, service } = setup();
  sql.exec('DROP VIEW drive_active_members');
  await assert.rejects(service.createFolder('alice', null, 'A'), /drive_active_members/);
  await assert.rejects(service.move('alice', 'missing', null, 'A'), /drive_active_members/);
});
