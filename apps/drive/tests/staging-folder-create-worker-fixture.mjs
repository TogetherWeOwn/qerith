import assert from 'node:assert/strict';

export async function exerciseStagingFolderCreate({ worker, DB, origin, session }) {
  const cookie = await session('folder-writer', 'member');
  await DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind)
    VALUES ('create-foreign', 'fixture', 'Foreign parent', 'folder')`).run();
  const path = '/api/folders';
  const create = (name, parentId, options = {}) => worker.fetch(origin + (options.path ?? path), {
    method: options.method ?? 'POST', redirect: 'manual',
    headers: { origin, cookie, 'content-type': 'application/json', 'x-test-invite': '1', ...options.headers },
    body: options.body ?? JSON.stringify({ name, parentId }),
  });
  const check = (response, status) => {
    assert.deepEqual([response.status, response.headers.get('cache-control'), response.headers.get('location')],
      [status, 'private, no-store', null]);
  };
  const denied = async (pending, status) => {
    const response = await pending;
    check(response, status);
    assert.equal(await response.text(), '');
  };
  const rows = () => DB.prepare(`SELECT id, parent_id, name, kind, object_key FROM drive_entries
    WHERE owner_id = 'folder-writer' ORDER BY name`).all().then(result => result.results);

  await denied(create('Closed', null, { headers: { 'x-test-invite': '0' } }), 404);
  await denied(create('Closed', null, { path: `${path}/` }), 404);
  await denied(create('Closed', null, { path: `${path}?alias=1` }), 404);
  await denied(create('Closed', null, { method: 'PUT' }), 404);
  await denied(create('Signed out', null, { headers: { cookie: '' } }), 401);
  await denied(create('Not same origin', null, { headers: { origin: 'https://elsewhere.example.test' } }), 403);
  await denied(create('Not same origin', null, { headers: { 'sec-fetch-site': 'same-site' } }), 403);
  await denied(create('', null, { body: '{"name":"First","name":"Second","parentId":null}' }), 400);
  await denied(create('Foreign', 'create-foreign'), 404);
  await denied(create('Missing parent', 'missing'), 404);
  assert.deepEqual(await rows(), []);

  const created = async (name, parentId) => {
    const response = await create(name, parentId);
    check(response, 201);
    const body = await response.json();
    assert.match(body.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(body, { id: body.id, parentId, name, kind: 'folder' });
    return body.id;
  };
  const root = await created('A new root', null);
  const nested = await created('B nested', root);
  await denied(create('B nested', root), 409);
  await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'folder-writer'").run();
  await denied(create('Revoked', root), 401);
  assert.deepEqual(await rows(), [
    { id: root, parent_id: null, name: 'A new root', kind: 'folder', object_key: null },
    { id: nested, parent_id: root, name: 'B nested', kind: 'folder', object_key: null },
  ]);
  console.log('Generated staging Worker: folder creation, exact admission, ownership, collisions and revocation passed');
}
