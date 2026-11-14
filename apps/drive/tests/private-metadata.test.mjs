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
  assert.ok(await service.createFolder('alice', 'a', null, 'Documents'));
  assert.equal(await service.get('bob', 'a'), null);
  assert.equal(await service.get('bob', 'missing'), null);
  assert.equal(await service.move('bob', 'a', null, 'stolen'), null);
  assert.deepEqual(await service.list('bob', null), []);
  assert.equal(await service.createFolder('revoked', 'r', null, 'No'), null);
  sql.exec("UPDATE members SET active = 0 WHERE id = 'alice'");
  assert.equal(await service.get('alice', 'a'), null);
  assert.deepEqual(await service.list('alice', null), []);
  assert.equal(await service.move('alice', 'a', null, 'No'), null);
  sql.exec("UPDATE members SET active = 1 WHERE id = 'alice'");
  assert.equal((await service.get('alice', 'a')).name, 'Documents');
});

test('sibling uniqueness and parent ownership apply on create and move', async () => {
  const { service } = setup();
  assert.ok(await service.createFolder('alice', 'a', null, 'A'));
  assert.ok(await service.createFolder('alice', 'b', null, 'B'));
  assert.ok(await service.createFolder('bob', 'c', null, 'A'));
  assert.equal(await service.createFolder('alice', 'd', null, 'A'), null);
  assert.equal(await service.createFolder('alice', 'd', 'c', 'child'), null);
  assert.equal(await service.move('alice', 'b', null, 'A'), null);
  assert.ok(await service.move('alice', 'b', 'a', 'B'));
  assert.equal(await service.move('alice', 'b', 'c', 'B'), null);
});

test('cycles and object identity changes are rejected without copying bytes', async () => {
  const { sql, service } = setup();
  await service.createFolder('alice', 'a', null, 'A');
  await service.createFolder('alice', 'b', 'a', 'B');
  await service.createFolder('alice', 'c', 'b', 'C');
  assert.equal(await service.move('alice', 'a', 'c', 'A'), null);
  assert.equal(await service.move('alice', 'a', 'a', 'A'), null);
  sql.prepare("INSERT INTO drive_entries VALUES (?, ?, ?, ?, ?, ?)")
    .run('f', 'alice', 'a', 'file', 'file', 'opaque-key');
  assert.ok(await service.move('alice', 'f', 'b', 'renamed'));
  assert.equal(sql.prepare("SELECT object_key FROM drive_entries WHERE id = 'f'").get().object_key, 'opaque-key');
  assert.throws(() => sql.exec("UPDATE drive_entries SET object_key = 'other' WHERE id = 'f'"));
  assert.equal(await service.createFolder('alice', 'bad', 'f', 'child'), null);
});
