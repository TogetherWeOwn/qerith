import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { exerciseQualificationFiles } from '../scripts/staging-qualification-files.mjs';

export async function exerciseStagingQualificationFiles({ worker, DB, origin, session }) {
  const ownerId = randomUUID(), recipientId = randomUUID();
  const ownerCookie = await session(ownerId, 'owner'), recipientCookie = await session(recipientId, 'member');
  const request = async (cookie, path, { headers, ...init } = {}) => {
    const url = origin + path;
    const response = await worker.fetch(url, {
      ...init, redirect: 'manual', headers: {
        cookie, origin, 'x-test-grant-boundary': 'worker', 'x-test-invite': '1', 'x-test-read-grants': '1', ...headers,
      },
    });
    // Wrangler's in-process dispatch omits Response.url. Use the exact URL
    // dispatched by this fixture, which cannot follow redirects.
    if (path.startsWith('/f/') && response.url === '') Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  const json = async (path, value, status) => {
    const response = await request(ownerCookie, path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    });
    assert.equal(response.status, status);
    return response.json();
  };
  const fileName = 'Qualification file.bin', fileBytes = Uint8Array.of(0, 1, 128, 255);
  const { id: intent } = await json('/api/uploads', { size: fileBytes.length }, 201);
  const upload = `/api/uploads/${intent}`;
  const part = await request(ownerCookie, `${upload}/parts/1`, {
    method: 'PUT', body: fileBytes, headers: {
      'content-type': 'application/octet-stream', 'content-length': String(fileBytes.length),
    },
  });
  assert.equal(part.status, 204);
  const { id: fileId } = await json(`${upload}/complete`, { name: fileName, parentId: null }, 201);
  const folderName = 'Qualification anchor';
  const { id: folderId } = await json('/api/folders', { name: folderName, parentId: null }, 201);
  const anchor = `/f/${folderId}`;
  const prefix = 'drive-qualification/full-v0/1/1/';
  const context = { runId: '1', attempt: '1', prefix };
  const fixture = { prefix, fileId, fileName, fileBytes, folderId, folderName, ownerId, recipientId };
  const provisioning = { prefix, fileId, folderId };
  const recipient = { principalId: recipientId, request: (path, init) => request(recipientCookie, path, init) };
  const folders = async () => (await DB.prepare(
    "SELECT name, parent_id FROM drive_entries WHERE owner_id = ? AND kind = 'folder' ORDER BY name",
  ).bind(ownerId).all()).results;
  const run = request => exerciseQualificationFiles(context, undefined, {
    fixture, provisioning, recipient, owner: { principalId: ownerId, request },
  });

  const trace = [];
  let unavailable;
  await assert.rejects(run(async (path, init) => {
    trace.push([init.method, path]);
    const response = await request(path === anchor ? recipientCookie : ownerCookie, path, init);
    if (path === anchor) unavailable = [response.status, await response.clone().text()];
    return response;
  }), /folder-operations/);
  assert.deepEqual(trace, [['GET', `/api/download/${fileId}`], ['GET', anchor]]);
  assert.equal(unavailable[0], 200, 'the generated unavailable view is a 200 document');
  assert.match(unavailable[1], /This folder isn't available/);
  assert.deepEqual(await folders(), [{ name: folderName, parent_id: null }]);

  assert.deepEqual(await run((path, init) => request(ownerCookie, path, init)), {
    'authenticated-file-access': 'pass', 'folder-operations': 'pass', 'share-and-revoke': 'pass',
  });
  const destination = await DB.prepare("SELECT id FROM drive_entries WHERE owner_id = ? AND name = 'Qualification destination'")
    .bind(ownerId).first();
  assert.deepEqual(await folders(), [
    { name: folderName, parent_id: null },
    { name: 'Qualification child', parent_id: destination.id },
    { name: 'Qualification destination', parent_id: folderId },
    { name: 'Qualification source', parent_id: folderId },
  ]);
  console.log('Generated staging Worker: qualification folder create/list/move and unavailable document before mutation passed');
}
