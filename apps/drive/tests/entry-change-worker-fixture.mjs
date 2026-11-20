import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export const entryChangeWorker = `import { entryChangeRequest } from ${JSON.stringify(resolve('src/lib/server/entry-change-route.ts'))};`;
const file = 'move résumé';
const pathFor = id => `/api/entries/${encodeURIComponent(id)}`;
const rename = name => ({ kind: 'rename', name });
const move = parentId => ({ kind: 'move', parentId });

async function patch(worker, origin, cookie, path, command, headers = {}) {
  const response = await worker.fetch(origin + path, {
    method: 'PATCH', redirect: 'manual', headers: { origin, cookie, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(command),
  });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('location'), null);
  return response;
}

export async function assertEntryChangeClosed({ worker, DB, origin, owner, member }) {
  await DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind) VALUES
    ('closed-owner', 'fixture', 'Owner original', 'folder'),
    ('closed-member', 'member', 'Member original', 'folder')`).run();
  for (const [id, cookie, headers] of [
    ['closed-owner', owner, {}],
    ['closed-owner', owner, { 'x-test-invite': '1' }],
    ['closed-member', member, { 'x-test-invite': '1' }],
  ]) {
    const row = DB.prepare('SELECT * FROM drive_entries WHERE id = ?').bind(id);
    const before = await row.first();
    assert.ok(before);
    const response = await patch(worker, origin, cookie, pathFor(id), rename('Should not change'), headers);
    assert.deepEqual([response.status, await response.text()], [404, '']);
    assert.deepEqual(await row.first(), before);
  }
}

export async function exerciseEntryChange({ worker, DB, origin, session }) {
  const owner = await session('move-owner', 'member');
  const other = await session('move-other', 'member');
  await DB.batch([
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES
      ('move-parent', 'move-owner', NULL, 'Parent', 'folder'),
      ('move-child', 'move-owner', 'move-parent', 'Child', 'folder'),
      ('move-sibling', 'move-owner', 'move-child', 'Taken', 'folder'),
      ('move-foreign', 'move-other', NULL, 'Foreign', 'folder')`),
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
      VALUES (?, 'move-owner', 'move-parent', 'Original', 'file', 'fixture-object', 1)`).bind(file),
  ]);
  const change = (command, id = file, cookie = owner, headers) => patch(worker, origin, cookie, pathFor(id), command, headers);
  const denied = async (pending, status) => {
    const response = await pending;
    assert.deepEqual([response.status, await response.text()], [status, '']);
  };
  const changed = async (command, parentId, name) => {
    const result = await change(command);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { id: file, parentId, name, kind: 'file' });
  };

  await changed(rename('Renamed'), 'move-parent', 'Renamed');
  await changed(move('move-child'), 'move-child', 'Renamed');
  const snapshot = () => DB.prepare("SELECT id, parent_id, name, object_key FROM drive_entries WHERE owner_id IN ('move-owner', 'move-other') ORDER BY id").all();
  const beforeDenials = (await snapshot()).results;
  await denied(change(rename('Taken')), 409);
  await denied(change(move('move-foreign')), 404);
  await denied(change(move('missing')), 404);
  await denied(change(rename('Denied'), file, other), 404);
  await denied(change(move('move-child'), 'move-parent'), 404);
  await denied(change({ ...rename('Denied'), parentId: null }), 400);
  await denied(change(move('x'.repeat(513)), file), 400);
  await denied(change(rename('Denied'), file, owner, { 'sec-fetch-site': 'cross-site' }), 403);
  await denied(change(rename('Denied'), file, owner, { origin: 'https://elsewhere.example.test' }), 403);
  assert.deepEqual((await snapshot()).results, beforeDenials);
  await changed({ ...move(null), name: 'Combined' }, null, 'Combined');
  await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'move-owner'").run();
  await denied(change(rename('Revoked')), 401);
  assert.deepEqual(await DB.prepare('SELECT parent_id, name, object_key FROM drive_entries WHERE id = ?').bind(file).first(),
    { parent_id: null, name: 'Combined', object_key: 'fixture-object' });
  console.log('Generated Worker fixture: session entry changes, collisions, invalid commands, ownership and revocation passed');
}
