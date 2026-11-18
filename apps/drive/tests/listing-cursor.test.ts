import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { decodeCursor, encodeCursor, folderScope } from '../src/lib/server/metadata/listing-cursor';

test('binds the full scope digest to the exact folder ID', async () => {
  const scope = await folderScope('Root');
  assert.equal(scope, createHash('sha256').update('["drive:list:scope:v2","folder","Root"]').digest('base64url'));
  assert.match(scope, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(scope, await folderScope('root'));
  assert.notEqual(await folderScope('café'), await folderScope('café'.normalize('NFD')));
});

test('round-trips bounded cursors only for the matching folder and direction', async () => {
  const folder = 'long-folder-'.repeat(400);
  const scope = await folderScope(folder);
  const sibling = await folderScope(`${folder}x`);
  for (const direction of ['asc', 'desc'] as const) {
    for (const kind of ['folder', 'file'] as const) {
      for (const name of ['é'.repeat(127) + 'x', '\\"'.repeat(127) + 'x', String.fromCodePoint(0xfeff), `${String.fromCodePoint(0xfeff)}name`]) {
        const boundary = { kind, name };
        const cursor = encodeCursor(boundary, scope, direction);
        assert.match(cursor, /^[A-Za-z0-9_-]{1,595}$/);
        assert.deepEqual(decodeCursor(cursor, scope, direction), boundary);
        assert.equal(decodeCursor(cursor, sibling, direction), null);
        assert.equal(decodeCursor(cursor, scope, direction === 'asc' ? 'desc' : 'asc'), null);
      }
    }
  }
});

test('rejects invalid cursor shapes, encodings and names', async () => {
  const scope = await folderScope('root');
  const cursor = encodeCursor({ kind: 'file', name: 'last' }, scope, 'asc');
  const envelope = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const changes = [
    { v: 1 }, { o: 'locale' }, { k: 'other' }, { extra: true },
    { n: '_w' }, { n: 'YQ==' }, { n: 'YR' }, // Non-UTF-8, padded and noncanonical.
    ...['', '/', ' . ', '\0', 'é'.repeat(128)].map((name) => ({ n: Buffer.from(name).toString('base64url') })),
  ];
  for (const token of ['', 'invalid!', `${cursor}=`, 'x'.repeat(2049), encode(null), encode([]),
    ...changes.map((change) => encode({ ...envelope, ...change }))]) {
    assert.equal(decodeCursor(token, scope, 'asc'), null);
  }
});
