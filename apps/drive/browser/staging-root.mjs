import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempDisposable, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';
import { proveNewFolder } from './new-folder.mjs';
import { captureFolderView } from './folder-view.mjs';
import { proveInvite } from './invite-runtime.mjs';
import { fixture, userHandle } from '../tests/ceremony-fixture.ts';

const origin = 'https://qerith-drive-staging.5150.workers.dev';
const rpID = new URL(origin).hostname;
const sessionName = '__Host-drive-session';
const dataPath = '/__data.json';
await using dir = await mkdtempDisposable('../.svelte-kit/staging-root-browser-');
const config = JSON.parse(await readFile('../wrangler.build.jsonc', 'utf8'));
const configPath = resolve(dir.path, 'wrangler.json');
const main = resolve(dir.path, 'relay.mjs');
await writeFile(main, `import { withEnv } from 'cloudflare:workers';
import worker from ${JSON.stringify(resolve('../.svelte-kit/cloudflare/_worker.js'))};
import { bindings, storageCalls, storageFetch, truncateNextDownload } from ${JSON.stringify(resolve('upload-storage.mjs'))};
globalThis.fetch = storageFetch;
export default { fetch(request, env, ctx) {
  const input = new Request(request);
  // Fetch in the local relay replaces Sec-Fetch-Mode. Restore browser navigations only.
  if (input.headers.has('x-fixture-navigation')) {
    input.headers.set('sec-fetch-mode', 'navigate');
    input.headers.set('sec-fetch-dest', 'document');
    input.headers.delete('x-fixture-navigation');
  }
  if (input.headers.has('x-fixture-storage-count')) return Response.json(storageCalls());
  if (input.headers.has('x-fixture-short-download')) {
    truncateNextDownload();
    input.headers.delete('x-fixture-short-download');
  }
  const configured = { ...env, ...bindings };
  if (input.headers.get('x-fixture-invite') === '1') {
    configured.DRIVE_STAGING_INVITE_ACCEPTANCE = '1';
    input.headers.delete('x-fixture-invite');
  }
  return withEnv(configured, () => worker.fetch(input, configured, ctx));
} };`);
await writeFile(configPath, JSON.stringify({ ...config, main,
  assets: { ...config.assets, directory: resolve('..', config.assets.directory) },
  d1_databases: [{ binding: 'DB', database_name: 'staging-root-test', database_id: '00000000-0000-4000-8000-000000000001' }],
}));
const harness = createTestHarness({ workers: [{ configPath, vars: { DRIVE_ORIGIN: origin } }] });
let browser;
try {
  await harness.listen();
  const worker = harness.getWorker();
  const { DB } = await worker.getEnv();
  for (const name of (await readdir('../migrations')).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(`../migrations/${name}`, 'utf8');
    await DB.batch(unstable_splitSqlQuery(sql).map(statement => DB.prepare(statement)));
  }
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const { credential } = await fixture('authentication', { key, origin, rpID });
  await DB.prepare(`INSERT INTO drive_principals (id, role, status, webauthn_user_handle)
    VALUES ('owner', 'owner', 'active', ?), ('member', 'member', 'active', NULL)`).bind(userHandle).run();
  await DB.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
    VALUES (?, 'owner', ?, 0, '[]', ?)`).bind(credential.id, Array.from(credential.publicKey), userHandle).run();
  const memberToken = randomBytes(32).toString('base64url');
  await DB.prepare('INSERT INTO drive_sessions (token_hash, principal_id, expires_at) VALUES (?, ?, ?)')
    .bind(createHash('sha256').update(memberToken).digest('hex'), 'member', Date.now() + 120_000).run();

  const get = (path, headers, method = 'GET', host = origin) => worker.fetch(host + path, { method, headers, redirect: 'manual' });
  const redirect = await get('/', { 'x-fixture-navigation': '1', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.get('location'), '/sign-in?next=%2F');

  browser = await chromium.launch({ ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  // Keep interception armed across documents and chooser events, as in the sign-in fixture.
  page.on('filechooser', () => {});
  const authenticator = await context.newCDPSession(page);
  await authenticator.send('WebAuthn.enable');
  const { authenticatorId } = await authenticator.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const base64 = value => Buffer.from(value, 'base64url').toString('base64');
  await authenticator.send('WebAuthn.addCredential', { authenticatorId, credential: {
    credentialId: base64(credential.id), isResidentCredential: true, rpId: rpID, signCount: 0,
    privateKey: Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)).toString('base64'), userHandle: base64(userHandle),
  } });

  const assets = new Set();
  let holdRefresh, pendingNotice;
  const relay = async (route, target = worker, navigationSite) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    const headers = await request.allHeaders();
    let seededNotice;
    if (request.isNavigationRequest()) {
      headers['x-fixture-navigation'] = '1';
      // Playwright can intercept a navigation before Chromium adds fetch metadata.
      if (navigationSite) headers['sec-fetch-site'] = navigationSite;
      if (pendingNotice && url.pathname === '/' && url.search === `?download=${pendingNotice.nonce}`) {
        // Seed this Worker document request only; the relay is not a browser cookie transport.
        seededNotice = pendingNotice;
        pendingNotice = undefined;
        headers['sec-fetch-site'] = 'same-origin';
        headers.cookie = `${headers.cookie}; ${seededNotice.name}=${seededNotice.value}`;
      }
    }
    const body = request.postDataBuffer();
    if (body) headers['content-length'] ??= String(body.length);
    const response = await target.fetch(url, { method: request.method(), headers, body, redirect: 'manual' });
    if (seededNotice) {
      seededNotice.expired = response.headers.getSetCookie().some(value =>
        value.startsWith(`${seededNotice.name}=;`) && /(?:^|;\s*)Max-Age=0(?:;|$)/i.test(value));
    }
    if (response.ok && url.pathname.startsWith('/_app/immutable/')) assets.add(url.pathname);
    if (url.pathname === dataPath) await holdRefresh;
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  };
  let rootRelay = relay;
  await context.route('**/*', route => rootRelay(route));
  await page.goto(origin + redirect.headers.get('location'), { waitUntil: 'networkidle' });
  const signInAssets = new Set(assets);
  await Promise.all([page.waitForURL(origin + '/'), page.getByRole('button', { name: 'Sign in with a passkey' }).click()]);
  const session = (await context.cookies(origin)).find(cookie => cookie.name === sessionName);
  assert.ok(session?.httpOnly && session.secure);
  const cookie = `${sessionName}=${session.value}`;

  const upload = page.getByRole('button', { name: 'Upload', exact: true });
  await upload.and(page.locator('[aria-disabled="false"]')).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Users and invites' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'New folder', exact: true }).count(), 0);
  await page.keyboard.press('Tab');
  assert.equal(await upload.evaluate(el => document.activeElement === el), true);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  assert.equal(chooser.isMultiple(), false);
  const file = { name: 'staging-proof.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 255, 12, 44, 128, 4]) };
  let navigations = 0;
  const countNavigation = request => { if (request.isNavigationRequest()) navigations++; };
  page.on('request', countNavigation);
  const [refresh] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === dataPath), chooser.setFiles(file),
  ]);
  assert.deepEqual([refresh.request().method(), refresh.status(), (await refresh.allHeaders())['cache-control']],
    ['GET', 200, 'private, no-store']);
  const row = page.getByRole('link', { name: file.name, exact: true });
  await row.waitFor();
  page.off('request', countNavigation);
  assert.equal(navigations, 0, 'upload refreshed the row without navigation');
  assert.equal(await upload.evaluate(el => document.activeElement === el), true);
  const [download] = await Promise.all([page.waitForEvent('download'), row.press('Enter')]);
  assert.equal(download.suggestedFilename(), file.name);
  assert.deepEqual(await readFile(await download.path()), file.buffer);
  const partial = await page.evaluate(async href => {
    const response = await fetch(href, { headers: { range: 'bytes=1-3' }, redirect: 'error' });
    return [response.status, response.headers.get('content-range'), Array.from(new Uint8Array(await response.arrayBuffer()))];
  }, await row.getAttribute('href'));
  assert.deepEqual(partial, [206, 'bytes 1-3/6', Array.from(file.buffer.subarray(1, 4))]);

  // Without invite mode the owner picker still rejects files above the preview cap.
  const size = 16 * 1024 * 1024 + 1;
  const oversized = 'Above preview cap.bin';
  const uploadRequests = [];
  const recordUpload = request => { if (new URL(request.url()).pathname.startsWith('/api/uploads')) uploadRequests.push(request.method()); };
  page.on('request', recordUpload);
  await page.locator('input[type="file"]').setInputFiles({ ...file, name: oversized, buffer: Buffer.alloc(size) });
  await page.getByRole('status').filter({ hasText: `${oversized}: Upload interrupted.` }).waitFor();
  page.off('request', recordUpload);
  assert.deepEqual(uploadRequests, [], 'preview rejects before allocation');

  // Another upload pushes the last row to page two after the user tabs to it.
  await DB.prepare(`WITH RECURSIVE pages(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM pages WHERE n < 99)
    INSERT INTO drive_entries (id, owner_id, name, kind)
    SELECT printf('00000000-0000-4000-8000-%012d', n), 'owner', printf('Folder %03d', n), 'folder' FROM pages`).run();
  const failedDownload = await row.getAttribute('href');
  const notice = page.getByRole('alert');
  const noticeRetry = notice.getByRole('link', { name: 'Retry download', exact: true });
  const listingRetry = page.getByRole('link', { name: 'Try again', exact: true });
  async function renderNotice(target, nonce, name, value) {
    const seeded = pendingNotice = { nonce, name, value, expired: false };
    const document = await target.goto(`${origin}/?download=${nonce}`);
    assert.equal(document?.status(), 200);
    assert.ok(seeded.expired, 'the Worker sent an expiration header for the notice cookie');
  }
  function visitWithNotice(value = failedDownload.split('/').at(-1)) {
    const nonce = crypto.randomUUID();
    return renderNotice(page, nonce, `__Host-drive-download-failed-${nonce}`, value);
  }
  await visitWithNotice();
  assert.equal(await noticeRetry.getAttribute('href'), failedDownload);
  await upload.and(page.locator('[aria-disabled="false"]')).waitFor();
  await upload.focus();
  await upload.and(page.locator(':focus')).waitFor();
  const [nextChooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5_000 }), page.keyboard.press('Enter')]);
  const held = Promise.withResolvers();
  holdRefresh = held.promise;
  try {
    await Promise.all([page.waitForRequest(request => new URL(request.url()).pathname === dataPath),
      nextChooser.setFiles({ ...file, name: 'A.bin' })]);
    await page.keyboard.press('Tab');
    assert.equal(await row.evaluate(el => document.activeElement === el), true);
  } finally {
    held.resolve();
    holdRefresh = undefined;
  }
  await row.waitFor({ state: 'detached' });
  await page.getByRole('link', { name: 'A.bin', exact: true }).waitFor();
  assert.equal(await upload.evaluate(el => document.activeElement === el), true);
  assert.equal(await noticeRetry.getAttribute('href'), failedDownload, 'refresh preserves the document notice');

  // Damage only the disposable listing index; upload and live-owner admission still work.
  const index = await DB.prepare("SELECT sql FROM sqlite_schema WHERE name = 'drive_entries_listing_asc'").first('sql');
  await DB.prepare('DROP INDEX drive_entries_listing_asc').run();
  await upload.and(page.locator('[aria-disabled="false"]')).waitFor();
  const [failedRefreshChooser] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('Enter')]);
  await failedRefreshChooser.setFiles({ ...file, name: 'B.bin' });
  await listingRetry.and(page.locator(':focus')).waitFor();
  const receipt = page.getByRole('status').filter({ hasText: 'B.bin: Uploaded. Refresh My Drive to see it.' });
  assert.ok((await receipt.boundingBox())?.height > 1, 'the upload receipt remains visible');
  assert.equal(await page.getByRole('link', { name: 'A.bin', exact: true }).count(), 0, 'stale rows are removed');
  assert.equal(await listingRetry.getAttribute('href'), '/');
  assert.equal(await noticeRetry.getAttribute('href'), failedDownload, 'an unavailable listing preserves the document notice');
  await visitWithNotice();
  await page.getByText("This folder didn't load.", { exact: false }).waitFor();
  assert.equal(await noticeRetry.getAttribute('href'), failedDownload);
  await visitWithNotice('unavailable');
  await notice.getByText('The file didn’t download.', { exact: true }).waitFor();
  assert.equal(await notice.getByRole('link').count(), 0);
  assert.equal(await listingRetry.getAttribute('href'), '/');
  await DB.prepare(index).run();

  const privateNodes = [...assets].filter(path => /\/nodes\/.*\.js$/.test(path) && !signInAssets.has(path));
  assert.ok(privateNodes.length, 'hydration loaded a root-only generated node');
  const data = new URL(refresh.url());
  const protectedPaths = [data.pathname + data.search, ...privateNodes];
  async function deny(path, expected, headers, method, host) {
    const response = await get(path, headers, method, host);
    assert.deepEqual([response.status, response.headers.get('cache-control'), await response.text()],
      [expected, 'private, no-store', ''], `${method ?? 'GET'} ${path}`);
  }
  for (const path of protectedPaths) {
    await deny(path, 401);
    await deny(path, 403, { cookie: `${sessionName}=${memberToken}` });
    await deny(path, 403, { cookie, origin: 'https://other.example.test' });
    await deny(path, 403, { cookie, origin }, 'GET', 'https://other.example.test');
    await deny(path, 403, { cookie, 'sec-fetch-site': 'cross-site' });
  }
  for (const path of ['/sign-in/__data.json', '/shared/__data.json', '/__data.json/', '/%5f_data.json',
    '/_app/env.js', '/_app/version.json', `${privateNodes[0]}.map`, '/sign-in.html', '/api/root-listing']) {
    await deny(path, 404, { cookie });
  }
  await deny(dataPath, 404, { cookie }, 'HEAD');
  await deny(dataPath, 404, { cookie, origin }, 'POST');
  const inviteWorker = { fetch(url, init) {
    const headers = new Headers(init.headers);
    headers.set('x-fixture-invite', '1');
    return worker.fetch(url, { ...init, headers });
  } };
  const recipientNodes = await proveInvite(browser, { origin, relay: (route, site) => relay(route, inviteWorker, site),
    worker: inviteWorker, DB, ownerToken: session.value,
    stagingRoot: { asset: privateNodes[0], ownerDownload: failedDownload, ownerFile: file, defaultWorker: worker,
      otherMemberCookie: `${sessionName}=${memberToken}`,
      storageCalls: async () => (await get('/', { 'x-fixture-storage-count': '1' })).json(), renderNotice } });
  const inviteNodes = recipientNodes.filter(path => !signInAssets.has(path) && !privateNodes.includes(path));
  assert.ok(inviteNodes.length > 0, 'staging invite loaded an invite-specific generated route node');
  for (const path of inviteNodes) await deny(path, 404, {});
  assert.equal((await inviteWorker.fetch(`${origin}/invite`, { method: 'HEAD', headers: {
    cookie, 'x-fixture-navigation': '1', 'sec-fetch-site': 'cross-site',
  } })).status, 403);
  await deny('/', 403, { cookie: `${sessionName}=${memberToken}` });
  await deny('/', 401, { cookie: `${sessionName}=${memberToken}` }, 'HEAD');

  await DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('fixture-parent', 'owner', 'Receipts', 'folder')").run();
  await deny('/f/fixture-parent', 404, { cookie });
  const overrides = new Map(); // One owner for each Playwright route, including injected failures.
  rootRelay = route => {
    const { pathname } = new URL(route.request().url());
    const forward = (optIn = true) => relay(route, optIn ? inviteWorker : worker, 'same-origin');
    const override = overrides.get(pathname);
    overrides.delete(pathname);
    return override ? override(route, forward) : forward();
  };
  await captureFolderView(page, origin, DB, { owner: 'owner', scope: 'staging-folder' });
  assert.ok(await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some(font => font.family.replaceAll('"', '') === 'Qerith Sans' && font.status === 'loaded');
  }), 'the opted-in SSR folder loads its actual font');
  await proveNewFolder(page, origin, DB, 'owner', (path, handler) => overrides.set(path, handler));

  await DB.prepare("UPDATE drive_sessions SET expires_at = 0 WHERE principal_id = 'owner'").run();
  const recovery = await inviteWorker.fetch(`${origin}/people`, { headers: { cookie, 'x-fixture-navigation': '1', 'sec-fetch-site': 'same-origin' }, redirect: 'manual' });
  await page.goto(origin + recovery.headers.get('location'), { waitUntil: 'networkidle' });
  await Promise.all([page.waitForURL(`${origin}/people`), page.getByRole('button', { name: 'Sign in with a passkey' }).click()]);
  const recovered = (await context.cookies(origin)).find(cookie => cookie.name === sessionName);
  await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'owner'").run();
  for (const path of protectedPaths) await deny(path, 401, { cookie: `${sessionName}=${recovered.value}` });

  await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, 'staging-root-round-trip.json'), JSON.stringify({
    mode: 'staging-origin', signIn: 'passkey', picker: 'Tab then Enter', navigations, focusRestored: true,
    noticePreservedOnRefresh: true, noticePreservedOnListingFailure: true, focusRestoredOnListingFailure: true,
    uploadReceiptVisibleOnListingFailure: true,
    workerExpiresSyntheticNoticeCookie: true, distinctRetryLinks: true, nonRetryableNoticeHasNoLink: true,
    refresh: { method: 'GET', path: dataPath, status: 200 }, fullDownload: { bytes: file.buffer.length, byteIdentical: true },
    rangeDownload: { status: partial[0], contentRange: partial[1], byteIdentical: true }, denied: {
      signedOut: 401, member: 403, revoked: 401, wrongOrigin: 403, crossSite: 403, unlisted: 404,
    },
  }, null, 2));
  console.log('Staging-origin Worker + Chromium + D1: passkey, keyboard picker, root data refresh, full/range download and denials passed');
} finally {
  await browser?.close();
  await harness.close();
}
