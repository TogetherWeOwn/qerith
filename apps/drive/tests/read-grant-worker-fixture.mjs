import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export const readGrantWorker = `import { readGrantRequest } from ${JSON.stringify(resolve('src/lib/server/read-grant-routes.ts'))};`;
const folder = 'share-folder';
const file = 'share file';
const pathFor = id => `/api/entries/${encodeURIComponent(id)}/read-grants`;
export const readGrantPath = pathFor(folder);

export async function exerciseReadGrants({ worker, DB, origin, session }) {
  const owner = await session('share-owner', 'member');
  const recipientId = 'share-récipient';
  const recipient = await session(recipientId, 'member');
  await DB.batch([
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES
      (?, 'share-owner', NULL, 'Share folder', 'folder'),
      ('share-nested', 'share-owner', ?, 'Share nested', 'folder'),
      ('share-pages', 'share-owner', NULL, 'Share pages', 'folder')`).bind(folder, folder),
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
      VALUES (?, 'share-owner', 'share-nested', 'Share file', 'file', 'private-object-key', 1)`).bind(file),
  ]);
  const ask = (path, cookie, method = 'GET', headers = {}, body) => worker.fetch(origin + path, {
    method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin }), ...headers }, body,
  });
  const status = async (response, expected) => {
    const result = await response;
    assert.deepEqual([result.status, await result.text(), result.headers.get('cache-control'), result.headers.get('location')],
      [expected, '', 'private, no-store', null]);
  };
  const list = async (path, cookie = owner) => {
    const result = await ask(path, cookie);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
    return result.json();
  };
  const item = (id, grantee = recipientId) => `${pathFor(id)}/${encodeURIComponent(grantee)}`;
  const shared = '/api/shared-listing';
  const nested = '/api/folder-listing?folderId=share-nested';
  const empty = { recipients: [], nextCursor: null };
  const granted = { recipients: [{ recipientId }], nextCursor: null };
  assert.deepEqual(await list(readGrantPath), empty);
  await status(ask(readGrantPath, null), 401);
  await status(ask(nested, recipient), 404);

  // A file grant does not expose its parent or create an inherited grant row.
  await status(ask(item(file), owner, 'PUT', {}, '{}'), 400);
  await status(ask(item(file), owner, 'PUT'), 204);
  assert.deepEqual(await list(pathFor(file)), granted);
  assert.deepEqual((await list(shared, recipient)).entries, [{ id: file, name: 'Share file', kind: 'file' }]);
  await status(ask(nested, recipient), 404);
  await status(ask(item(file), owner, 'PUT'), 404);
  await status(ask(item(file, 'missing'), owner, 'PUT'), 404);
  await status(ask(item(file), owner, 'DELETE'), 204);
  assert.deepEqual((await list(shared, recipient)).entries, []);

  await status(ask(item(folder), owner, 'PUT', { origin: 'https://other.example.test' }), 403);
  await status(ask(item(folder), owner, 'PUT', { 'sec-fetch-site': 'same-site' }), 403);
  assert.deepEqual(await list(readGrantPath), empty);
  await status(ask(item(folder), owner, 'PUT'), 204);
  assert.deepEqual(await list(readGrantPath), granted);
  assert.deepEqual(await list(pathFor(file)), empty);
  assert.deepEqual((await list(nested, recipient)).entries, [{ id: file, name: 'Share file', kind: 'file' }]);

  await status(ask(readGrantPath, recipient), 404);
  await status(ask(pathFor('missing'), recipient), 404);
  await status(ask(item(folder, 'other'), recipient, 'PUT'), 404);
  await status(ask(item(file, 'other'), recipient, 'PUT'), 404);
  await status(ask(item(folder), recipient, 'DELETE'), 404);
  await status(ask('/api/folders', recipient, 'POST', { 'content-type': 'application/json' },
    JSON.stringify({ name: 'Denied write', parentId: folder })), 404);
  await status(ask(item(folder), owner, 'DELETE', { 'sec-fetch-site': 'cross-site' }), 403);
  assert.deepEqual(await list(readGrantPath), granted);
  await status(ask(item(folder), owner, 'DELETE'), 204);
  await status(ask(item(folder), owner, 'DELETE'), 404);
  await status(ask(nested, recipient), 404);
  assert.deepEqual((await list(shared, recipient)).entries, []);

  const ids = Array.from({ length: 101 }, (_, i) => `share-page-${String(i).padStart(3, '0')}`);
  await DB.batch([
    DB.prepare("INSERT INTO drive_principals (id, role, status) SELECT value, 'member', 'active' FROM json_each(?)").bind(JSON.stringify(ids)),
    DB.prepare("INSERT INTO drive_read_grants SELECT 'share-pages', value FROM json_each(?)").bind(JSON.stringify(ids)),
  ]);
  const page = pathFor('share-pages');
  const nextCursor = ids[99];
  assert.deepEqual(await list(page), { recipients: ids.slice(0, 100).map(recipientId => ({ recipientId })), nextCursor });
  await status(ask(item('share-pages', nextCursor), owner, 'DELETE'), 204);
  const next = `${page}?cursor=${nextCursor}`;
  assert.deepEqual(await list(next), { recipients: [{ recipientId: ids[100] }], nextCursor: null });
  await status(ask(next, recipient), 404);

  await status(ask(item(folder), owner, 'PUT'), 204);
  await DB.prepare("UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = 'share-owner'").run();
  await status(ask(next, owner), 401);
  await status(ask(item(file), owner, 'PUT'), 401);
  await status(ask(item(folder), owner, 'DELETE'), 401);
  assert.deepEqual((await list(nested, recipient)).entries, [{ id: file, name: 'Share file', kind: 'file' }]);
  assert.deepEqual((await DB.prepare('SELECT recipient_id FROM drive_read_grants WHERE entry_id = ?').bind(folder).all()).results,
    [{ recipient_id: recipientId }]);
  console.log('Generated Worker fixture: explicit grants, inherited reads, pagination, non-owner writes, revocation and stale sessions passed');
}
