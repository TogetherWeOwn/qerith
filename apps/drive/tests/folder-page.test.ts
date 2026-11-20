import assert from 'node:assert/strict';
import test from 'node:test';
import { folderPage } from '../src/lib/server/folder-page';

const request = (query = '') => new Request(`https://example.test/f/private?${query}`);
const unavailable = { status: 'unavailable' };
const authorize = async () => 'session-token';
const get = async (_token: string, id: string) => ({ id, name: 'Receipts', kind: 'folder' as const, owner_id: 'private-owner' });

test('does not read without authorization or with a malformed page', async () => {
  const read = test.mock.fn(async () => null);
  const readAccess = { get: read, list: read };
  assert.deepEqual(await folderPage(request(), 'private', { authorize: async () => null, readAccess }), unavailable);
  for (const bad of ['page=', 'page=a&page=b', `page=${'x'.repeat(379)}`])
    assert.deepEqual(await folderPage(request(bad), 'private', { authorize, readAccess }), unavailable);
  assert.equal(read.mock.callCount(), 0);
});

test('projects safe fields and resumes a stable opaque boundary for an overlong entry ID', async () => {
  const cursor = { id: 'x'.repeat(4096), name: `Résumé ${'é'.repeat(123)}` };
  const later = { id: 'next', name: 'Z', kind: 'file' as const };
  for (const anchor of [cursor, { ...cursor, name: 'A' }]) {
    const item = { ...anchor, kind: 'file' as const };
    const readAccess = { get, list: async () => ({ entries: [{ ...item, object_key: 'private-key' }], nextCursor: anchor }) };
    const page = await folderPage(request(), 'private', { authorize, readAccess });
    assert(page.status === 'ok' && page.folder.nextPage);
    assert.deepEqual(page.folder.entries, [item]);
    assert.match(page.folder.nextPage, /^[A-Za-z0-9_-]{378}$/);
    const next = request(`page=${page.folder.nextPage}`);
    // An entry that takes the boundary name is behind the cursor too.
    for (const entries of [[later], [{ ...item, id: 'replacement', name: anchor.name }, later], null]) {
      const list = test.mock.fn(async (_token: string, _id: string, _after?: typeof cursor | null) => entries && { entries, nextCursor: null });
      const expected = entries ? { status: 'ok', folder: { name: 'Receipts', entries: [later], nextPage: null, paged: true } } : unavailable;
      assert.deepEqual(await folderPage(next, 'private', { authorize, readAccess: { get, list } }), expected);
      assert.deepEqual(list.mock.calls.map(call => call.arguments), [[await authorize(), 'private', { name: anchor.name, id: '' }]]);
    }
    assert.deepEqual(await folderPage(next, 'other', { authorize, readAccess }), unavailable);
    assert.deepEqual(await folderPage(next, 'private', { authorize: async () => 'another-session', readAccess }), unavailable);
  }
});

test('does not disclose the title if live listing is denied, fails or exceeds the bound', async () => {
  for (const list of [async () => null, async () => { throw new Error('storage failed'); }, async () => ({ entries: Array(101).fill(await get('', 'private')), nextCursor: null })])
    assert.deepEqual(await folderPage(request(), 'private', { authorize, readAccess: { get, list } }), unavailable);
});
