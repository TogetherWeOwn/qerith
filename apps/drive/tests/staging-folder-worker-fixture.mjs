import assert from 'node:assert/strict';

export async function exerciseStagingFolder({ worker, DB, origin, owner, member }) {
  await DB.batch([
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind) VALUES
      ('folder-proof', 'fixture', 'Folder proof title', 'folder'), ('folder-own', 'member', 'Member own folder', 'folder')`),
    DB.prepare(`WITH RECURSIVE rows(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM rows WHERE n<101)
      INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
      SELECT 'folder-proof-' || n, 'fixture', 'folder-proof', printf('Row %03d', n), 'file', 'folder-key-' || n, 1 FROM rows`),
  ]);
  const folder = '/f/folder-proof';
  const read = (path, cookie, { on = true, method = 'GET', host = origin } = {}) =>
    worker.fetch(host + path, { method, redirect: 'manual', headers: {
      ...(cookie ? { cookie } : {}), ...(on ? { 'x-test-invite': '1' } : {}),
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
  const first = await body(folder, owner, 200);
  assert.match(first, /Folder proof title/);
  assert.equal((first.match(/<li\b/g) ?? []).length, 100);
  assert.doesNotMatch(first, /Row 101|folder-key-|<script\b/);
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
  assert.doesNotMatch(second, /Row 100|folder-key-/);
  await unavailable(`${folder}?page=invalid`, owner);
  await unavailable(folder, member);
  assert.match(await body('/f/folder-own', member, 200), /Member own folder/);
  await DB.prepare("INSERT INTO drive_read_grants (entry_id, recipient_id) VALUES ('folder-proof', 'member')").run();
  assert.match(await body(folder, member, 200), /Folder proof title/);
  await unavailable(folder + page, member);
  const memberPage = (await body(folder, member, 200)).match(/href="(\?page=[A-Za-z0-9_-]{378})"/)?.[1];
  assert.ok(memberPage);
  await unavailable('/f/folder-own' + memberPage, member);
  await DB.prepare("DELETE FROM drive_read_grants WHERE entry_id = 'folder-proof'").run();
  await unavailable(folder, member);
  await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'").run();
  for (const path of [folder, ...folderOnly]) assert.equal(await body(path, member, 401), '');
  console.log('Generated staging Worker: exact SSR folder, grant and cursor bounds, and private stylesheet passed');
}
