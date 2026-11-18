import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCursor, encodeCursor, folderScope } from '../src/lib/server/metadata/listing-cursor';

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
