import assert from 'node:assert/strict';
import test from 'node:test';
import { folderPage } from '../src/lib/server/folder-page';

const request = (query = '') => new Request(`https://example.test/f/private?${query}`);
const unavailable = { status: 'unavailable' };
const authorize = async () => 'session-token';
const get = async (_token: string, id: string) => ({ id, name: 'Receipts', kind: 'folder' as const, owner_id: 'private-owner' });

test('does not read without authorization or with a malformed page', async () => {
  let reads = 0;
  const read = async () => { reads++; return null; };
  const readAccess = { get: read, list: read };
  assert.deepEqual(await folderPage(request(), 'private'), unavailable);
  assert.deepEqual(await folderPage(request(), 'private', { authorize: async () => null, readAccess }), unavailable);
  for (const bad of ['page=', 'page=a&page=b', `page=${'x'.repeat(379)}`])
    assert.deepEqual(await folderPage(request(bad), 'private', { authorize, readAccess }), unavailable);
  assert.equal(reads, 0);
});

test('projects safe fields and resumes a stable opaque boundary for an overlong entry ID', async () => {
  const cursor = { id: 'x'.repeat(4096), name: `Résumé ${'é'.repeat(123)}` };
  const item = { ...cursor, kind: 'file' as const };
  const later = { ...item, id: 'next', name: 'Z' };
  const readAccess = { get, list: async () => ({ entries: [{ ...item, object_key: 'private-key' }], nextCursor: cursor }) };
  const first = await folderPage(request(), 'private', { authorize, readAccess });
  assert(first.status === 'ok' && first.folder.nextPage);
  assert.deepEqual(first.folder.entries, [item]);
  const next = request(`page=${first.folder.nextPage}`);
  assert(!next.url.includes(cursor.name) && !next.url.includes(encodeURIComponent(cursor.name)) && next.url.length < 450);
  const list = async (_token: string, _id: string, after?: typeof cursor | null) => {
    assert.deepEqual(after, { id: '', name: cursor.name });
    return { entries: [item, later], nextCursor: null };
  };
  assert.deepEqual(await folderPage(next, 'private', { authorize, readAccess: { get, list } }), {
    status: 'ok', folder: { name: 'Receipts', entries: [later], nextPage: null, paged: true }
  });
  assert.deepEqual(await folderPage(next, 'other', { authorize, readAccess }), unavailable);
  assert.deepEqual(await folderPage(next, 'private', { authorize: async () => 'another-session', readAccess }), unavailable);
});

test('does not disclose the title if live listing is denied, fails or exceeds the bound', async () => {
  for (const list of [async () => null, async () => { throw new Error('storage failed'); }, async () => ({ entries: Array(101).fill(await get('', 'private')), nextCursor: null })])
    assert.deepEqual(await folderPage(request(), 'private', { authorize, readAccess: { get, list } }), unavailable);
});
