import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { entryShare } from '../src/lib/share-client.ts';

export const readGrantWorker = `import { readGrantRequest } from ${JSON.stringify(resolve('src/lib/server/read-grant-routes.ts'))};`;
const folder = 'share-folder';
const file = 'share file';
const pathFor = id => `/api/entries/${encodeURIComponent(id)}/read-grants`;
export const readGrantPath = pathFor(folder);

const operations = [['GET', ''], ['PUT', '/reader'], ['DELETE', '/reader']];
const boundaries = ['worker', 'adapter'];
const stagingFetch = (worker, origin, boundary) => (method, path, cookie, headers = {}, body, host = origin) =>
  worker.fetch(host + path, { method, redirect: 'manual', body, headers: {
    ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin: host }),
    'x-test-grant-boundary': boundary, ...headers,
  } });

async function expectPrivateEmpty(response, status, label) {
  const result = await response;
  assert.deepEqual([result.status, result.headers.get('cache-control'), result.headers.get('location'), await result.text()],
    [status, 'private, no-store', null, ''], label);
}

export async function refusePreviewReadGrants({ worker, origin, cookie }) {
  for (const boundary of boundaries) {
    const ask = stagingFetch(worker, origin, boundary);
    for (const [method, suffix] of operations) {
      await expectPrivateEmpty(ask(method, readGrantPath + suffix, cookie, {
        'x-test-sign-in-fixture': '1', 'x-test-read-grants': '1', 'x-test-invite': '1',
      }), 404, `${boundary}: non-staging configured origin cannot admit ${method}`);
    }
  }
}

export async function exerciseStagingReadGrants({ worker, DB, origin, session, driveOwner, download, downloadBytes }) {
  const source = 'share / read';
  const path = pathFor(source);
  const item = `${path}/reader`;
  const owner = await session('grant-owner', 'member');
  const reader = await session('reader', 'member');
  await DB.batch([
    DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, 'grant-owner', 'Shared folder', 'folder')").bind(source),
    DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES ('grant-child', 'grant-owner', ?, 'Child', 'folder')").bind(source),
  ]);
  const active = { 'x-test-read-grants': '1', 'sec-fetch-site': 'same-origin' };
  const empty = { recipients: [], nextCursor: null };
  const granted = { recipients: [{ recipientId: 'reader' }], nextCursor: null };
  for (const boundary of boundaries) {
    const ask = stagingFetch(worker, origin, boundary);
    const send = (method, path, cookie = owner, headers = {}, body, host) => ask(method, path, cookie, { ...active, ...headers }, body, host);
    const reject = (response, status, label) => expectPrivateEmpty(response, status, `${boundary}: ${label}`);
    const list = async (url = path) => {
      const response = await send('GET', url);
      assert.deepEqual([response.status, response.headers.get('cache-control')], [200, 'private, no-store'], boundary);
      return response.json();
    };
    for (const [method, suffix] of operations) {
      for (const flag of [undefined, '0', 'true']) {
        await reject(ask(method, path + suffix, owner, {
          ...(flag === undefined ? {} : { 'x-test-read-grants': flag }), 'x-test-invite': '1', 'x-test-sign-in-fixture': '1',
        }), 404, `read-grant opt-in is exact for ${method}`);
      }
      await reject(send(method, path + suffix, owner, {}, undefined, 'https://raw.example.test'), 403, 'wrong host');
      await reject(send(method, path + suffix, null), 401, 'no session');
      await reject(send(method, path + suffix, driveOwner), 404, 'different principal, even a Drive owner');
    }
    for (const [method, url] of [['HEAD', path], ['POST', item], ['GET', item], ['PUT', path],
      ['PUT', `${item}/`], ['PUT', item.replace('reader', '%72eader')], ['GET', path.replaceAll('%2F', '%2f')]]) {
      await reject(send(method, url), 404, `${method} ${url}`);
    }
    if (boundary === 'worker') {
      await reject(send('DELETE', `${item}/extra`), 404, 'extra path segment');
      await reject(send('GET', `${path}?x-sveltekit-probe=1`), 400, 'reserved query not forwarded');
      await reject(send('PUT', item, owner, { origin: 'https://raw.example.test' }), 403, 'wrong Origin without content type');
    }
    await reject(send('GET', `${path}?cursor=${'x'.repeat(513)}`), 400, 'oversized cursor');
    await reject(send('PUT', item, owner, {}, '{}'), 400, 'body not accepted');
    await reject(send('PUT', `${item}?cursor=x`), 400, 'mutation query not accepted');
    // With no Content-Type SvelteKit would reject this before Drive's hook runs.
    await reject(send('PUT', item, owner, { origin: 'https://raw.example.test', 'content-type': 'application/json' }), 403, 'wrong Origin');
    await reject(send('PUT', item, owner, { 'sec-fetch-site': 'cross-site' }), 403, 'cross-site mutation');
    assert.deepEqual(await list(), empty, 'denied requests left no grant');
    await reject(send('PUT', item), 204, 'member owner grants read');
    assert.deepEqual(await list(), granted);
    for (const [method, url] of [['GET', path], ['DELETE', item], ['PUT', `${path}/other`],
      ['PUT', `${pathFor('grant-child')}/other`]]) {
      await reject(send(method, url, reader), 404, 'reader cannot manage direct or inherited grants');
    }
    await reject(send('DELETE', item, owner, { 'sec-fetch-site': 'same-site' }), 403, 'same-site mutation');
    assert.deepEqual(await list(), granted, 'denied requests neither removed nor amplified the grant');
    await reject(send('DELETE', item), 204, 'member owner revokes read');
    assert.deepEqual(await list(`${path}?cursor=reader`), empty);
  }
  const workerGrant = stagingFetch(worker, origin, 'worker');
  const adapterGrant = stagingFetch(worker, origin, 'adapter');
  for (const [recipientId, escapedId] of [
    ['__data.json', '%5F_data.json'],
    ['__route.js', '%5F_route.js'],
    ['file.html__data.json', 'file.html%5F_data.json'],
    ['file.html__route.js', 'file.html%5F_route.js'],
  ]) {
    await session(recipientId, 'member');
    const canonical = `${path}/${recipientId}`;
    const alias = `${path}/${escapedId}`;
    for (const ask of [workerGrant, adapterGrant]) {
      await expectPrivateEmpty(ask('PUT', alias, owner, active), 404, 'escaped path is not a public alias');
    }
    await expectPrivateEmpty(workerGrant('PUT', canonical, owner), 404, 'reserved IDs still require opt-in');
    await expectPrivateEmpty(workerGrant('PUT', canonical, owner, active, '{}'), 400, 'reserved IDs still reject a body');
    await expectPrivateEmpty(workerGrant('PUT', canonical, owner, active), 204, `grant ${recipientId}`);
    const read = async () => {
      const response = await workerGrant('GET', path, owner, active);
      assert.deepEqual([response.status, response.headers.get('cache-control')], [200, 'private, no-store']);
      return response.json();
    };
    assert.deepEqual(await read(), { recipients: [{ recipientId }], nextCursor: null });
    await expectPrivateEmpty(workerGrant('DELETE', canonical, owner, active), 204, `revoke ${recipientId}`);
    assert.deepEqual(await read(), empty);
  }
  await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'grant-owner'").run();
  for (const boundary of boundaries) for (const [method, suffix] of operations) {
    await expectPrivateEmpty(stagingFetch(worker, origin, boundary)(method, path + suffix, owner, active), 401, 'revoked session');
  }
  assert.equal(await DB.prepare("SELECT COUNT(*) AS count FROM drive_read_grants WHERE entry_id IN (?, 'grant-child')").bind(source).first('count'), 0);
  const ask = stagingFetch(worker, origin, 'worker');
  const fileGrant = `${pathFor(download.split('/').at(-1))}/reader`;
  await expectPrivateEmpty(ask('PUT', fileGrant, driveOwner, active), 204, 'Drive owner grants read on its own file');
  const both = { ...active, 'x-test-invite': '1' };
  await expectPrivateEmpty(ask('GET', download, reader, active), 403, 'grant management alone does not admit downloads');
  const grantedDownload = await ask('GET', download, reader, { 'x-test-invite': '1' });
  assert.deepEqual([grantedDownload.status, grantedDownload.headers.get('cache-control'), await grantedDownload.text()],
    [200, 'private, no-store', downloadBytes], 'invite mode delivers the granted file');
  for (const path of ['/shared', '/api/shared-listing']) {
    await expectPrivateEmpty(ask('GET', path, reader, both), 404, 'no Shared with me surface');
  }
  await expectPrivateEmpty(ask('DELETE', fileGrant, driveOwner, active), 204, 'remove file grant');
  await expectPrivateEmpty(ask('GET', download, reader, both), 404, 'revocation closes file delivery');
  console.log('Generated Worker and direct adapter: default-off read-grant admission and D1 ownership checks passed');
}

export async function exerciseReadGrants({ worker, DB, origin, session }) {
  const owner = await session('share-owner', 'member');
  const recipientId = 'share-récipient';
  const recipient = await session(recipientId, 'member');
  const displayName = 'Shared with Émie';
  await DB.batch([
    DB.prepare('UPDATE drive_principals SET display_name = ? WHERE id = ?').bind(displayName, recipientId),
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
  const client = (id, cookie = owner) => entryShare(id, (path, init) => worker.fetch(origin + path, {
    ...init, headers: { cookie, ...(init?.method ? { origin } : {}) },
  }));
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

  const person = { recipientId, displayName };
  const inheritedFrom = 'Share folder';
  const root = await client(folder).listAccessPage();
  assert.equal(root.complete, true);
  assert.deepEqual(root.access, [{ ...person, direct: true, inheritedFrom: null }]);
  const nestedShare = client(file);
  const inherited = await nestedShare.listAccessPage();
  assert.equal(inherited.complete, true);
  assert.deepEqual(inherited.access, [{ ...person, direct: false, inheritedFrom }]);
  assert.ok(!inherited.candidates.some(row => row.recipientId === recipientId));
  await assert.rejects(client(file, recipient).listAccessPage(), /Share list unavailable/);

  await nestedShare.grant(recipientId);
  assert.deepEqual((await nestedShare.listAccessPage()).access, [{ ...person, direct: true, inheritedFrom }]);
  await nestedShare.revoke(recipientId);
  assert.deepEqual((await nestedShare.listAccessPage()).access, inherited.access);

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
  const removed = await nestedShare.listAccessPage();
  assert.deepEqual(removed.access, []);
  assert.deepEqual(removed.candidates.find(row => row.recipientId === recipientId), person);
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
  await assert.rejects(nestedShare.listAccessPage(), /Share list unavailable/);
  await status(ask(item(file), owner, 'PUT'), 401);
  await status(ask(item(folder), owner, 'DELETE'), 401);
  assert.deepEqual((await list(nested, recipient)).entries, [{ id: file, name: 'Share file', kind: 'file' }]);
  assert.deepEqual((await DB.prepare('SELECT recipient_id FROM drive_read_grants WHERE entry_id = ?').bind(folder).all()).results,
    [{ recipient_id: recipientId }]);
  console.log('Generated Worker fixture: root and nested Share client, explicit grants, inheritance, pagination, revocation and stale sessions passed');
}
