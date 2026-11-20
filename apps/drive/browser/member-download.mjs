import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const { uploadToRoot } = await tsImport('../src/lib/root-upload.ts', import.meta.url);
const fixtureOrigin = 'https://drive.example.test';
const bytes = Buffer.from([11, 129, 0, 255, 33, 91]);
const name = 'Member-only résumé.txt';
const navigation = { 'x-fixture-navigation': '1', 'sec-fetch-site': 'same-origin' };

export async function proveMemberDownload(page, { origin, defaultWorker, DB, id, cookie, check,
  ownerDownload, ownerFile, checkOwner, storageCalls, renderNotice, captureState }) {
  assert.notDeepEqual(bytes.subarray(1, 4), ownerFile.buffer.subarray(1, 4), 'the tested range distinguishes member and owner bytes');
  // Only fixture setup uses a member upload. The staged member may not upload.
  const setupStatuses = [];
  const published = await uploadToRoot(new File([bytes], name), () => {}, async (path, init) => {
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(await init.body.arrayBuffer());
    headers.set('origin', fixtureOrigin);
    headers.set('cookie', cookie);
    headers.set('content-length', String(body.length));
    const response = await defaultWorker.fetch(fixtureOrigin + path, { method: init.method, headers, body, redirect: 'manual' });
    setupStatuses.push(response.status);
    return response;
  });
  assert.equal(published.status, 'published', `member publication setup: ${setupStatuses.join(', ')}`);
  const path = `/api/download/${published.id}`;
  const missing = `/api/download/${crypto.randomUUID()}`;
  const unpublished = crypto.randomUUID();
  await DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes)
    VALUES (?, ?, 'Unpublished.txt', 'file', 'internal-member-fixture-key', 1)`).bind(unpublished, id).run();
  await DB.prepare('INSERT INTO drive_read_grants (entry_id, recipient_id) VALUES (?, ?)')
    .bind(ownerDownload.split('/').at(-1), id).run();

  const noStorage = async action => {
    const before = await storageCalls();
    const response = await action();
    assert.equal(await storageCalls(), before, 'denial never dispatched to storage');
    return response;
  };
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
  await page.getByText('Unpublished.txt', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Unpublished.txt', exact: true }).count(), 0);
  assert.equal(await page.getByText(ownerFile.name, { exact: true }).count(), 0);
  assert.equal(await page.locator('input[type="file"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Upload', exact: true }).count(), 0);
  await captureState('member-root-listed');
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
    await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, 'staging-member-download.json'), JSON.stringify({
      full: { status: full.status, bytes: bytes.length, workerAndBrowserByteIdentical: true },
      range: { status: range.status, contentRange: partial[1], workerAndBrowserByteIdentical: true },
      deniedWithoutStorage: { grantedOtherOwner: 404, missing: 404, unpublished: 404, revoked: 401, flagOff: 403 },
      unpublishedRowIsPlainText: true, ownerByteIdenticalInInviteMode: true,
      retryDownloaded: true, unavailableNoticeOmitsNameAndRetry: true,
    }, null, 2));
  } };
}
