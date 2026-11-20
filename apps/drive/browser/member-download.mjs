import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const bytes = Buffer.from([11, 129, 0, 255, 33, 91]);
const name = 'Member-only résumé.txt';
const navigation = { 'x-fixture-navigation': '1', 'sec-fetch-site': 'same-origin' };

export async function proveMemberDownload(page, { origin, worker, defaultWorker, DB, id, cookie, otherMemberCookie, check,
  ownerDownload, ownerFile, checkOwner, storageCalls, renderNotice, captureState, holdNext }) {
  assert.notDeepEqual(bytes.subarray(1, 4), ownerFile.buffer.subarray(1, 4), 'the tested range distinguishes member and owner bytes');
  const noStorage = async action => {
    const before = await storageCalls();
    const response = await action();
    assert.equal(await storageCalls(), before, 'denial never dispatched to storage');
    return response;
  };
  const send = async ([path, method, data], expected, target = worker, overrides = {}) => {
    const json = data !== undefined && !Buffer.isBuffer(data);
    const body = json ? Buffer.from(JSON.stringify(data)) : data;
    const response = await target.fetch(origin + path, { method, body, redirect: 'manual', headers: {
      cookie, origin, ...(json && { 'content-type': 'application/json' }),
      ...(body && { 'content-length': String(body.length) }), ...overrides,
    } });
    assert.deepEqual([response.status, response.headers.get('cache-control')], [expected, 'private, no-store'], `${method} ${path}`);
    return response;
  };
  const denyUpload = async (...args) => assert.equal(await (await noStorage(() => send(...args))).text(), '');
  const allocate = ['/api/uploads', 'POST', { size: bytes.length }];
  await denyUpload(allocate, 403, defaultWorker);
  await denyUpload(allocate, 403, worker, { origin: 'https://other.example.test' });
  await denyUpload(allocate, 403, worker, { 'sec-fetch-site': 'cross-site' });
  await denyUpload(['/api/uploads/', 'POST', allocate[2]], 404);
  const intent = `/api/uploads/${(await (await send(allocate, 201)).json()).id}`;
  const part = [`${intent}/parts/1`, 'PUT', bytes];
  const complete = [`${intent}/complete`, 'POST', { name, parentId: null }];
  await denyUpload(part, 403, defaultWorker);
  await denyUpload(part, 404, worker, { cookie: otherMemberCookie });
  await denyUpload([`${intent}/parts/01`, 'PUT', bytes], 404);
  await denyUpload([part[0], 'GET'], 404);
  await send(part, 204);
  await denyUpload(complete, 403, defaultWorker);
  await denyUpload(complete, 404, worker, { cookie: otherMemberCookie });
  await denyUpload([`${complete[0]}?preview=1`, 'POST', complete[2]], 404);

  // Even a read grant for a valid folder does not authorize publication into it.
  const folder = crypto.randomUUID();
  const { owner_id: ownerId } = await DB.prepare('SELECT owner_id FROM drive_entries WHERE id = ?')
    .bind(ownerDownload.split('/').at(-1)).first();
  await DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, 'Owner folder', 'folder')").bind(folder, ownerId).run();
  await DB.prepare('INSERT INTO drive_read_grants (entry_id, recipient_id) VALUES (?, ?)').bind(folder, id).run();
  await denyUpload([complete[0], 'POST', { name, parentId: folder }], 404);
  const published = await (await send(complete, 201)).json();
  assert.deepEqual(await DB.prepare('SELECT owner_id, name, size_bytes FROM drive_entries WHERE id = ?').bind(published.id).first(),
    { owner_id: id, name, size_bytes: bytes.length });
  const pending = `/api/uploads/${(await (await send(allocate, 201)).json()).id}`;
  const path = `/api/download/${published.id}`;
  const missing = `/api/download/${crypto.randomUUID()}`;
  const unpublished = crypto.randomUUID();
  await DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes)
    VALUES (?, ?, 'Unpublished.txt', 'file', 'internal-member-fixture-key', 1)`).bind(unpublished, id).run();
  await DB.prepare('INSERT INTO drive_read_grants (entry_id, recipient_id) VALUES (?, ?)')
    .bind(ownerDownload.split('/').at(-1), id).run();

  const deny = async (download, status) => {
    const response = await noStorage(() => check(download, 'GET', status, { range: 'bytes=1-3' }));
    assert.equal(await response.text(), '');
    for (const header of ['content-disposition', 'content-range', 'etag']) assert.equal(response.headers.get(header), null);
  };
  await deny(ownerDownload, 404); // The grant is present; staging authorizes ownership only.
  await deny(missing, 404);
  await deny(`/api/download/${unpublished}`, 404);
  const disabled = await noStorage(() => defaultWorker.fetch(origin + path, { headers: { origin, cookie } }));
  assert.deepEqual([disabled.status, disabled.headers.get('cache-control'), await disabled.text()], [403, 'private, no-store', '']);
  for (const [method, alias] of [['HEAD', path], ['GET', `${path}/`], ['GET', `${path}/extra`]]) {
    assert.equal(await (await noStorage(() => check(alias, method, 404))).text(), '');
  }
  assert.deepEqual(Buffer.from(await (await checkOwner(ownerDownload, 200)).arrayBuffer()), ownerFile.buffer);

  const full = await check(path, 'GET', 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  assert.equal(full.headers.get('content-length'), String(bytes.length));
  const range = await check(path, 'GET', 206, { range: 'bytes=1-3' });
  assert.equal(range.headers.get('content-range'), 'bytes 1-3/6');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(1, 4));

  const document = await page.reload();
  assert.equal(document.status(), 200);
  assert.equal((await document.allHeaders())['cache-control'], 'private, no-store');
  await page.getByRole('heading', { name: 'My Drive', exact: true }).waitFor();
  const row = page.getByRole('link', { name, exact: true });
  assert.equal(await row.getAttribute('href'), path);
  assert.equal(await row.getAttribute('download'), null);
  const unpublishedName = page.getByText('Unpublished.txt', { exact: true });
  await unpublishedName.filter({ visible: true }).waitFor();
  assert.equal(await unpublishedName.and(page.locator('a')).count(), 0);
  assert.equal(await page.getByText(ownerFile.name, { exact: true }).count(), 0);
  await captureState('member-root-listed');
  const multipartPicker = await proveMemberMultipartPicker(page, { check, holdNext });
  const activate = async link => {
    const [download] = await Promise.all([page.waitForEvent('download'), link.press('Enter')]);
    assert.equal(download.suggestedFilename(), name);
    assert.deepEqual(await readFile(await download.path()), bytes);
  };
  await activate(row);
  assert.equal(page.url(), `${origin}/`);
  const partial = await page.evaluate(async href => {
    const response = await fetch(href, { headers: { range: 'bytes=1-3' }, redirect: 'error' });
    return [response.status, response.headers.get('content-range'), response.headers.get('cache-control'),
      Array.from(new Uint8Array(await response.arrayBuffer()))];
  }, path);
  assert.deepEqual(partial, [206, 'bytes 1-3/6', 'private, no-store', [...bytes.subarray(1, 4)]]);

  const notice = page.getByRole('alert');
  const showFailure = async (response, expected) => {
    const location = new URL(response.headers.get('location'), origin);
    const nonce = location.searchParams.get('download');
    assert.equal(location.pathname, '/');
    assert.match(nonce, /^[0-9a-f-]{36}$/);
    const cookieName = `__Host-drive-download-failed-${nonce}`;
    const issued = response.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=`));
    assert.equal(issued?.split(';')[0], `${cookieName}=${expected}`);
    await renderNotice(page, nonce, cookieName, expected);
  };
  await showFailure(await check(path, 'GET', 303, { ...navigation, 'x-fixture-short-download': '1' }), published.id);
  await notice.getByText(`${name} didn’t download.`, { exact: true }).waitFor();
  const retry = notice.getByRole('link', { name: 'Retry download', exact: true });
  assert.equal(await retry.getAttribute('href'), path);
  await captureState('member-download-retry');
  await activate(retry);

  await showFailure(await noStorage(() => check(ownerDownload, 'GET', 303, navigation)), 'unavailable');
  await notice.getByText('The file didn’t download.', { exact: true }).waitFor();
  assert.equal(await notice.getByRole('link').count(), 0);
  assert.equal(await page.getByText(ownerFile.name, { exact: true }).count(), 0);
  await captureState('member-download-unavailable');

  return { name, async checkRevoked() {
    await deny(path, 401);
    await denyUpload(allocate, 401);
    await denyUpload([`${pending}/parts/1`, 'PUT', bytes], 401);
    await denyUpload([`${pending}/complete`, 'POST', complete[2]], 401);
    await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, 'staging-member-download.json'), JSON.stringify({
      full: { status: full.status, bytes: bytes.length, workerAndBrowserByteIdentical: true },
      range: { status: range.status, contentRange: partial[1], workerAndBrowserByteIdentical: true },
      deniedWithoutStorage: { grantedOtherOwner: 404, missing: 404, unpublished: 404, revoked: 401, flagOff: 403 },
      upload: { allocated: 201, part: 204, published: 201, ownFile: true, deniedWithoutStorage: {
        flagOff: 403, revoked: 401, otherMember: 404, grantedFolder: 404, noncanonical: 404, wrongMethod: 404, crossOrigin: 403,
      } },
      multipartPicker, unpublishedRowIsPlainText: true, ownerByteIdenticalInInviteMode: true,
      retryDownloaded: true, unavailableNoticeOmitsNameAndRetry: true,
    }, null, 2));
  } };
}

async function proveMemberMultipartPicker(page, { check, holdNext }) {
  const cap = 16 * 1024 * 1024;
  const file = { name: 'Multipart picker.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(cap + 1, 91) };
  file.buffer[cap] = 173; // Distinguish the short final part from the first.
  const upload = page.getByRole('button', { name: 'Upload', exact: true });
  const progress = page.getByRole('progressbar', { name: file.name, exact: true });
  const responses = [];
  const track = response => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith('/api/uploads')) return;
    const request = response.request();
    responses.push([request.method(), path, response.status(), request.method() === 'PUT' ? request.postDataBuffer()?.length : null]);
  };
  // Hold inside the context relay; expiring a page route during fallback can continue the same request.
  const secondPart = /^\/api\/uploads\/[^/]+\/parts\/2$/;
  const releaseSecondPart = holdNext(secondPart);
  page.on('response', track);
  try {
    await upload.and(page.locator('[aria-disabled="false"]')).waitFor();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), upload.press('Enter')]);
    await Promise.all([
      page.waitForRequest(request => request.method() === 'PUT' && secondPart.test(new URL(request.url()).pathname)),
      chooser.setFiles(file),
    ]);
    await progress.and(page.locator(`progress[value="${cap}"][max="${cap + 1}"]`)).waitFor();
    assert.equal(await upload.getAttribute('aria-disabled'), 'true');
    assert.equal(responses.length, 2, 'the second part has not been acknowledged');
    releaseSecondPart();
    await page.getByRole('status').filter({ hasText: `${file.name}: Uploaded.` }).waitFor();
    const row = page.getByRole('link', { name: file.name, exact: true });
    await row.waitFor();
    assert.equal(await progress.getAttribute('value'), String(cap + 1));
    assert.equal(await upload.evaluate(el => document.activeElement === el), true);
    assert.equal(responses.length, 4);
    const intent = responses[1][1].replace(/\/parts\/1$/, '');
    assert.match(intent, /^\/api\/uploads\/[A-Za-z0-9_-]+$/);
    assert.deepEqual(responses, [
      ['POST', '/api/uploads', 201, null], ['PUT', `${intent}/parts/1`, 204, cap],
      ['PUT', `${intent}/parts/2`, 204, 1], ['POST', `${intent}/complete`, 201, null],
    ]);
    const href = await row.getAttribute('href');
    assert.match(href, /^\/api\/download\/[0-9a-f-]{36}$/);
    const download = await check(href, 'GET', 200);
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(file.buffer), 'download matches both uploaded parts');
    return { parts: [cap, 1], acknowledgedProgress: [cap, cap + 1], refreshedListing: true, retainedFocus: true, byteIdentical: true };
  } finally {
    releaseSecondPart();
    page.off('response', track);
  }
}
