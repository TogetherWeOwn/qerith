import assert from 'node:assert/strict';

export async function exerciseMoveDestinations({ worker, DB, origin, session }) {
  const cookie = await session('move-browser', 'member');
  const path = '/api/move-destinations';
  await DB.batch([
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind) VALUES
      ('move-source', 'move-browser', 'Source', 'folder'), ('move-dest', 'move-browser', 'Taxes', 'folder'),
      ('move-cursor-other', 'move-browser', 'Cursor elsewhere', 'folder'),
      ('move-picker-foreign', 'fixture', 'Shared by another member', 'folder')`),
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES
      ('move-descendant', 'move-browser', 'move-source', 'Descendant', 'folder')`),
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES
      ('move-file', 'move-browser', 'move-dest', 'File', 'file', 'move-test-object', 1)`),
    DB.prepare(`WITH RECURSIVE rows(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM rows WHERE n < 51)
      INSERT INTO drive_entries (id, owner_id, parent_id, name, kind)
      SELECT 'move-dest-' || n, 'move-browser', 'move-dest', printf('Folder %03d', n), 'folder' FROM rows`),
    DB.prepare("INSERT INTO drive_read_grants (entry_id, recipient_id) VALUES ('move-picker-foreign', 'move-browser')"),
  ]);

  const get = (query, headers = {}, target = path, method = 'GET') => worker.fetch(origin + target + query, {
    method, redirect: 'manual', headers: { cookie, 'x-test-invite': '1', ...headers },
  });
  async function row(response, status, label) {
    const received = await response;
    assert.deepEqual([received.status, received.headers.get('cache-control'), received.headers.get('location')],
      [status, 'private, no-store', null], label);
    if (status === 200) return received.json();
    assert.equal(await received.text(), '');
  }

  const source = '?entry=move-source';
  await row(get(source, { 'x-test-invite': '0' }), 404);
  await row(get(source, {}, `${path}/`), 404);
  await row(get(source, {}, path, 'HEAD'), 404);
  await row(get(source, { cookie: '' }), 401);
  await row(get(source, { 'sec-fetch-site': 'same-site' }), 403);
  await row(get(source, { origin: 'https://elsewhere.example.test' }), 403);
  await row(get(`${source}&entry=move-dest`), 400);
  for (const folder of ['move-picker-foreign', 'move-source', 'move-descendant', 'move-file', 'not-found']) {
    await row(get(`${source}&folder=${folder}`), 404, `unavailable destination: ${folder}`);
  }
  await row(get('?entry=move-picker-foreign'), 404);
  assert.deepEqual(await row(get(source), 200), { folderName: 'My Drive', currentParentId: null,
    folders: [{ id: 'move-cursor-other', name: 'Cursor elsewhere' }, { id: 'move-source', name: 'Source' },
      { id: 'move-dest', name: 'Taxes' }], next: null });

  const taxes = `${source}&folder=move-dest`;
  const first = await row(get(taxes), 200);
  assert.deepEqual(first, { folderName: 'Taxes', currentParentId: null, next: 'move-dest-50',
    folders: Array.from({ length: 50 }, (_, i) => ({ id: `move-dest-${i + 1}`, name: `Folder ${String(i + 1).padStart(3, '0')}` })) });
  assert.deepEqual(await row(get(`${taxes}&after=${first.next}`), 200), { folderName: 'Taxes', currentParentId: null,
    folders: [{ id: 'move-dest-51', name: 'Folder 051' }], next: null });
  for (const after of ['move-cursor-other', 'move-picker-foreign', 'move-file']) await row(get(`${taxes}&after=${after}`), 404);
  assert.deepEqual(await row(get('?entry=move-file&folder=move-dest-51'), 200), {
    folderName: 'Folder 051', currentParentId: 'move-dest', folders: [], next: null,
  });

  await DB.prepare("UPDATE drive_entries SET parent_id = 'move-cursor-other' WHERE id = 'move-file'").run();
  assert.equal((await row(get('?entry=move-file'), 200)).currentParentId, 'move-cursor-other');
  assert.deepEqual(await row(get(`${source}&folder=move-cursor-other`), 200), {
    folderName: 'Cursor elsewhere', currentParentId: null, folders: [], next: null,
  }, 'a folder containing only a file has no child destinations');

  // The deepest browsable folder remains a target, but doesn't advertise an unreachable child.
  await DB.prepare(`WITH RECURSIVE levels(n) AS (VALUES (2) UNION ALL SELECT n + 1 FROM levels WHERE n < 65)
    INSERT INTO drive_entries (id, owner_id, parent_id, name, kind)
    SELECT 'move-depth-' || n, 'move-browser', CASE WHEN n = 2 THEN 'move-cursor-other' ELSE 'move-depth-' || (n - 1) END,
      'Depth ' || n, 'folder' FROM levels ORDER BY n`).run();
  assert.deepEqual(await row(get(`${source}&folder=move-depth-63`), 200), {
    folderName: 'Depth 63', currentParentId: null, folders: [{ id: 'move-depth-64', name: 'Depth 64' }], next: null,
  });
  const deepest = `${source}&folder=move-depth-64`;
  assert.deepEqual(await row(get(deepest), 200), {
    folderName: 'Depth 64', currentParentId: null, folders: [], next: null,
  });
  await row(get(`${deepest}&after=move-depth-65`), 404);
  await row(get(`${source}&folder=move-depth-65`), 404);

  // A destination moved below the source after a prior read is no longer browsable.
  await DB.prepare("UPDATE drive_entries SET parent_id = 'move-source' WHERE id = 'move-dest'").run();
  await row(get(taxes), 404);
  await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'move-browser'").run();
  await row(get(source), 401);
  console.log('Generated staging Worker: owned Move pages, bounded cursor, and live destination checks passed');
}
