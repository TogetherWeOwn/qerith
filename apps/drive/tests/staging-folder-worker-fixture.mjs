import assert from 'node:assert/strict';

export async function exerciseStagingFolder({ worker, DB, origin, owner, member, fileId, downloadBytes }) {
  const unpublished = '00000000-0000-4000-8000-000000000611';
  const download = `/api/download/${fileId}`;
  await DB.batch([
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind) VALUES
      ('folder-proof', 'fixture', 'Folder proof title', 'folder'), ('folder-own', 'member', 'Member own folder', 'folder'),
      ('legacy:folder', 'fixture', 'Imported root folder', 'folder')`),
    DB.prepare("UPDATE drive_entries SET parent_id = 'folder-proof', name = 'Published fixture' WHERE id = ?").bind(fileId),
    DB.prepare(`WITH RECURSIVE rows(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM rows WHERE n<101)
      INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
      SELECT CASE WHEN n = 1 THEN ? ELSE 'folder-proof-' || n END,
        'fixture', 'folder-proof', printf('Row %03d', n), 'file', 'folder-key-' || n, 1 FROM rows`).bind(unpublished),
  ]);
  const folder = '/f/folder-proof';
  const read = (path, cookie, { on = true, method = 'GET', host = origin, headers = {} } = {}) =>
    worker.fetch(host + path, { method, redirect: 'manual', headers: {
      ...(cookie ? { cookie } : {}), ...(on ? { 'x-test-invite': '1' } : {}), ...headers,
    } });
  async function body(path, cookie, status, options) {
    const response = await read(path, cookie, options);
    assert.deepEqual([response.status, response.headers.get('cache-control')], [status, 'private, no-store'], path);
    return response.text();
  }
  const unavailable = async (path, cookie) => {
    const html = await body(path, cookie, 200);
    assert.match(html, /This folder isn't available/);
    assert.doesNotMatch(html, /Folder proof title|Member own folder|Row 001|folder-key-/);
  };
  assert.equal(await body(folder, owner, 404, { on: false }), '');
  assert.equal(await body(folder, owner, 403, { host: 'https://raw-origin.example.test' }), '');
  assert.equal(await body(folder, null, 401), '');
  assert.equal(await body(folder, owner, 200, { method: 'HEAD' }), '');
  for (const path of [`${folder}/`, `${folder}/__data.json`, '/f/%66older-proof', '/api/folder-listing']) {
    assert.equal(await body(path, owner, 404), '');
  }
  const root = await body('/', owner, 200);
  const folderLink = root.match(/href="(\/f\/folder-proof)"/)?.[1];
  assert.equal(folderLink, folder, 'fresh My Drive links the canonical owned root folder');
  assert.match(root, /Imported root folder/);
  assert.doesNotMatch(root, /href="\/f\/legacy(?::|%3A)folder"/i);
  assert.ok(!(await body('/', owner, 200, { on: false })).includes(`href="${folder}"`));
  assert.ok(!(await body('/', member, 200)).includes(`href="${folder}"`));
  const first = await body(folderLink, owner, 200, { headers: {
    'x-test-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin',
  } });
  assert.match(first, /Folder proof title/);
  assert.equal((first.match(/<li\b/g) ?? []).length, 100);
  assert.doesNotMatch(first, /Row 100|Row 101|folder-key-|<script\b/);
  const downloadLink = first.match(/href="(\/api\/download\/[a-f0-9-]{36})"/)?.[1];
  assert.equal(downloadLink, download, 'only the published file links to the existing download endpoint');
  assert.match(first, /Row 001/);
  assert.ok(!first.includes(`href="/api/download/${unpublished}"`));
  assert.equal(await body(downloadLink, owner, 200), downloadBytes);
  assert.equal(await body(downloadLink, member, 404), '');
  const styles = [...first.matchAll(/href="([^"\s]+\.css)"/g)].map(([, href]) => new URL(href, origin + folder).pathname);
  assert.ok(styles.length, 'SSR references its generated stylesheet');
  const folderOnly = [];
  for (const path of styles) {
    const status = (await read(path, owner, { on: false })).status;
    if (status === 404) folderOnly.push(path);
    await body(path, member, 200);
  }
  assert.ok(folderOnly.length, 'folder references a stylesheet not admitted by the default surface');
  for (const path of folderOnly) assert.equal(await body(path, null, 401), '');

  const page = first.match(/href="(\?page=[A-Za-z0-9_-]{378})"/)?.[1];
  assert.ok(page);
  const second = await body(folder + page, owner, 200);
  assert.match(second, /Row 101/);
  assert.doesNotMatch(second, /Row 099|folder-key-/);
  await unavailable(`${folder}?page=invalid`, owner);
  await unavailable(folder, member);
  assert.match(await body('/f/folder-own', member, 200), /Member own folder/);
  const changeGrant = async method => {
    const response = await worker.fetch(`${origin}/api/entries/folder-proof/read-grants/member`, {
      method, redirect: 'manual', headers: {
        cookie: owner, origin, 'x-test-grant-boundary': 'worker', 'x-test-read-grants': '1',
      },
    });
    assert.deepEqual([response.status, response.headers.get('cache-control'), await response.text()], [204, 'private, no-store', '']);
  };
  await changeGrant('PUT');
  assert.ok((await body(folder, member, 200)).includes(`href="${download}"`), 'the existing folder grant permits the link');
  assert.equal(await body(downloadLink, member, 200), downloadBytes);
  await unavailable(folder + page, member);
  const memberPage = (await body(folder, member, 200)).match(/href="(\?page=[A-Za-z0-9_-]{378})"/)?.[1];
  assert.ok(memberPage);
  await unavailable('/f/folder-own' + memberPage, member);
  await changeGrant('DELETE');
  await unavailable(folder, member);
  assert.equal(await body(downloadLink, member, 404), '');
  await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'").run();
  for (const path of [folder, ...folderOnly]) assert.equal(await body(path, member, 401), '');
  console.log('Generated staging Worker: fresh root navigation, SSR folder downloads, grant and cursor bounds, and private stylesheet passed');
}
