import assert from 'node:assert/strict';
import test from 'node:test';
import { folderPage } from '../src/lib/server/folder-page';

const request = new Request('https://example.test/f/private');
const unavailable = { status: 'unavailable' };
const authorize = async () => 'session-token';
const get = async () => ({ id: 'private', name: 'Receipts', kind: 'folder' as const, owner_id: 'private-owner' });

test('does not read without authorization or with a malformed page', async () => {
  const unexpected = async () => { reads++; return null; };
  const readAccess = { get: unexpected, list: unexpected };
  let reads = 0;
  assert.deepEqual(await folderPage(request, 'private'), unavailable);
  assert.deepEqual(await folderPage(request, 'private', { authorize: async () => null, readAccess }), unavailable);
  for (const bad of ['page=null', 'page=%22ab%22', 'page=&page=', `page=${'x'.repeat(2049)}`]) {
    assert.deepEqual(await folderPage(new Request(`${request.url}?${bad}`), 'private', { authorize, readAccess }), unavailable);
  }
  assert.equal(reads, 0);
});

test('projects safe fields and round-trips the cursor without conflating the end and an empty folder', async () => {
  const cursor = { id: 'row', name: 'Résumé & receipts.pdf' };
  const item = { ...cursor, kind: 'file' as const };
  const nextPage = JSON.stringify([cursor.name, cursor.id]);
  const next = new Request(`${request.url}?${new URLSearchParams({ page: nextPage })}`);
  for (const [incoming, expected, entries] of [[request, null, [item]], [request, null, []], [next, cursor, []]] as const) {
    const list = async (token: string, id: string, after?: typeof cursor | null) => {
      assert.equal(token, 'session-token'); assert.equal(id, 'private'); assert.deepEqual(after, expected);
      return { entries: entries.map(entry => ({ ...entry, object_key: 'private-key' })), nextCursor: entries.length ? cursor : null };
    };
    assert.deepEqual(await folderPage(incoming, 'private', { authorize, readAccess: { get, list } }), {
      status: 'ok', folder: { name: 'Receipts', entries, nextPage: entries.length ? nextPage : null, paged: expected !== null }
    });
  }
});

test('does not disclose the title if live listing is denied, fails or exceeds the bound', async () => {
  for (const list of [async () => null, async () => { throw new Error('storage failed'); }, async () => ({ entries: Array(101).fill(await get()), nextCursor: null })]) {
    assert.deepEqual(await folderPage(request, 'private', { authorize, readAccess: { get, list } }), unavailable);
  }
});
