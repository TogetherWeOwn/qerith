import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempDisposable, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';
import { fixture, userHandle } from '../tests/ceremony-fixture.ts';
import { captureRootListing, captureSignedOut } from './root-listing.mjs';
import { proveOwnerEnrollment } from './owner-enrollment.mjs';
import { proveInvite } from './invite-runtime.mjs';
import { captureRootUpload } from './root-upload.mjs';
import { captureFolderView } from './folder-view.mjs';

const origin = 'https://drive.example.test';
const rpID = new URL(origin).hostname;
const endpoint = '/api/sign-in/';
const sessionName = '__Host-drive-session';
await using dir = await mkdtempDisposable('../.svelte-kit/sign-in-browser-');
const config = JSON.parse(await readFile('../wrangler.build.jsonc', 'utf8'));
const configPath = resolve(dir.path, 'wrangler.json');
const main = resolve(dir.path, 'navigation.mjs');
// The test relay's Fetch implementation replaces Sec-Fetch-Mode; restore it only in this fixture.
await writeFile(main, `import { withEnv } from 'cloudflare:workers';
import worker from ${JSON.stringify(resolve('../.svelte-kit/cloudflare/_worker.js'))};
import { storage, storageFetch } from ${JSON.stringify(resolve('upload-storage.mjs'))};
globalThis.fetch = storageFetch;
export default { fetch(request, env, ctx) {
  const input = new Request(request);
  if (input.headers.has('x-fixture-navigation')) input.headers.set('sec-fetch-mode', 'navigate');
  if (input.headers.has('x-fixture-navigation')) input.headers.set('sec-fetch-dest', 'document');
  input.headers.delete('x-fixture-navigation');
  if (!input.headers.has('x-fixture-storage')) return worker.fetch(input, env, ctx);
  input.headers.delete('x-fixture-storage');
  const configured = { ...env, ...storage };
  return withEnv(configured, () => worker.fetch(input, configured, ctx));
} };`);
await writeFile(configPath, JSON.stringify({ ...config, main,
  assets: { ...config.assets, directory: resolve('..', config.assets.directory) },
  d1_databases: [{ binding: 'DB', database_name: 'sign-in-fixture', database_id: '00000000-0000-4000-8000-000000000001' }],
}));
const harness = createTestHarness({ workers: [{ configPath, vars: { DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' } }] });
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
    VALUES ('fixture-owner', 'owner', 'active', ?)`).bind(userHandle).run();
  await DB.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
    VALUES (?, 'fixture-owner', ?, 0, '[]', ?)`).bind(credential.id, Array.from(credential.publicKey), userHandle).run();

  for (const path of ['/_app/env.js', '/_app/%65nv.js', '/_app/version.json', '/invite/unused', '/recover/unused']) {
    const response = await worker.fetch(`${origin}${path}`, { redirect: 'manual' });
    assert.equal(response.status, path.startsWith('/_app/') ? 503 : 404);
    assert.equal(response.headers.get('location'), null);
  }
  const post = (step, headers, body) => worker.fetch(`${origin}${endpoint}${step}`, {
    method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/json', ...headers }, body,
  });
  for (const step of ['challenge', 'restart', 'verify']) assert.equal((await post(step, { origin: 'https://other.example.test' })).status, 403);
  const navigation = { 'x-fixture-navigation': '1', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' };
  const visit = (method, headers) => worker.fetch(`${origin}/?return=1`, { method, headers, redirect: 'manual' });
  for (const site of ['same-origin', 'none', 'same-site', 'cross-site']) {
    const headers = { ...navigation, 'sec-fetch-site': site };
    for (const method of ['GET', 'HEAD']) {
      const redirect = await visit(method, headers);
      assert.equal(redirect.status, 303, `${method} from ${site}`);
      assert.equal(redirect.headers.get('location'), '/sign-in?next=%2F%3Freturn%3D1');
      assert.equal(redirect.headers.get('cache-control'), 'private, no-store');
    }
  }
  const crossSite = { ...navigation, 'sec-fetch-site': 'cross-site' };
  for (const method of ['GET', 'HEAD']) {
    for (const headers of [{ ...crossSite, range: 'bytes=0-' }, { ...crossSite, 'if-none-match': '"previous"' },
      { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'cross-site' }]) {
      const denied = await visit(method, headers);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('location'), null);
    }
  }
  const blocked = await worker.fetch(`${origin}/`, { headers: { ...navigation, origin: 'https://other.example.test' } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('cache-control'), 'private, no-store');
  assert.match(await blocked.text(), /<h1>Request blocked<\/h1>/);
  browser = await chromium.launch();
  const context = await browser.newContext();
  const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
  const authenticator = await context.newCDPSession(second);
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

  const lost = Promise.withResolvers();
  const drop = Promise.withResolvers();
  const verified = Promise.withResolvers();
  const deliver = Promise.withResolvers();
  const traffic = [];
  let loseNext = false;
  let configuredStorage = false;
  let failListing = false;
  let proof;
  const held = new Map();
  function holdResponse(matches) {
    const release = Promise.withResolvers();
    held.set(matches, release.promise);
    return () => { held.delete(matches); release.resolve(); };
  }
  const relay = async route => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    if (request.isNavigationRequest()) headers['x-fixture-navigation'] = '1';
    if (configuredStorage) headers['x-fixture-storage'] = '1';
    const body = request.postDataBuffer();
    if (body) headers['content-length'] ??= String(body.length);
    if (failListing && url.pathname === '/api/root-listing') {
      failListing = false;
      return route.fulfill({ status: 503, headers: { 'cache-control': 'private, no-store' } });
    }
    const response = await worker.fetch(url, { method: request.method(), headers, body, redirect: 'manual' });
    if (url.pathname.startsWith(endpoint)) traffic.push([url.pathname.slice(endpoint.length), response.status]);
    if (loseNext && url.pathname === `${endpoint}challenge` && response.status === 200) {
      loseNext = false;
      lost.resolve(response.headers.get('set-cookie').split(';')[0].split('=')[1].split('.'));
      await drop.promise;
      return route.abort('connectionreset');
    }
    if (url.pathname === `${endpoint}verify` && response.status === 204) {
      proof = { cookie: headers.cookie, body: request.postData() };
      verified.resolve();
      await deliver.promise;
    }
    for (const [matches, release] of held) if (matches(url.pathname)) await release;
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  };
  await context.route(`${origin}/**`, relay);
  const signInFrom = async (page, path) => {
    const response = await worker.fetch(`${origin}${path}`, { headers: navigation, redirect: 'manual' });
    assert.equal(response.status, 303);
    return page.goto(`${origin}${response.headers.get('location')}`, { waitUntil: 'networkidle' });
  };
  await DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('fixture-parent', 'fixture-owner', 'Receipts', 'folder')").run();
  await signInFrom(first, '/f/fixture-parent');
  assert.equal(new URL(first.url()).searchParams.get('next'), '/f/fixture-parent');
  await captureSignedOut(first, 'folder');
  await DB.prepare("DELETE FROM drive_entries WHERE id = 'fixture-parent'").run();
  await Promise.all([signInFrom(first, '/?tab=one'), signInFrom(second, '/shared?tab=two')]);
  await captureSignedOut(first);
  assert.equal(await first.evaluate(async endpoint => (await fetch(`${endpoint}challenge`, { method: 'POST' })).status, endpoint), 200);
  await first.evaluate(() => sessionStorage.setItem('fixture-interrupted-upload', 'present'));
  loseNext = true;
  const primary = page => page.getByRole('button', { name: 'Sign in with a passkey' });
  await primary(first).click();
  const [lostContext, lostChallenge] = await lost.promise;
  await primary(second).click();
  drop.resolve();
  await verified.promise;
  await primary(first).click();
  await first.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name === 'drive-passkey-sign-in'));
  assert.equal((await context.cookies(origin)).some(cookie => cookie.name === sessionName), false);
  assert.deepEqual(traffic, [['challenge', 200], ['challenge', 200], ['challenge', 409], ['restart', 200], ['verify', 204]]);
  assert.deepEqual(await DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE context = ?')
    .bind(lostContext).first(), { challenge: lostChallenge });
  await second.getByRole('button', { name: 'Cancel' }).click();
  deliver.resolve();
  await Promise.all([first.waitForURL(`${origin}/?tab=one`), second.waitForURL(`${origin}/`)]);
  assert.equal(traffic.filter(([step]) => step === 'verify').length, 1);
  const session = (await context.cookies(origin)).find(cookie => cookie.name === sessionName);
  assert.ok(session?.httpOnly && session.secure && session.sameSite === 'Lax');
  const signedIn = await visit('HEAD', { ...crossSite, cookie: `${sessionName}=${session.value}` });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.headers.get('location'), null);
  const tokenHash = createHash('sha256').update(session.value).digest('hex');
  assert.equal((await DB.prepare('SELECT principal_id FROM drive_sessions WHERE token_hash = ?').bind(tokenHash).first()).principal_id, 'fixture-owner');
  const privateStatus = () => first.evaluate(async () => (await fetch('/', { method: 'HEAD' })).status);
  assert.equal(await privateStatus(), 200);
  assert.equal(await first.evaluate(() => sessionStorage.getItem('fixture-interrupted-upload')), 'present');
  await captureRootListing(first, origin, DB);
  await captureFolderView(first, origin, DB);
  configuredStorage = true;
  await captureRootUpload(first, origin, holdResponse, () => { failListing = true; }, DB);
  configuredStorage = false;
  assert.equal((await post('verify', { cookie: proof.cookie }, proof.body)).status, 401);
  await first.goto(origin);
  const next = first.getByRole('link', { name: 'Next page' });
  const target = await next.getAttribute('href');
  assert.match(target, /^\/\?page=/);
  await next.click();
  await first.waitForURL(origin + target);
  await first.getByRole('table').getByRole('link', { name: 'Second.bin', exact: true }).waitFor();
  await first.getByRole('link', { name: 'Back to first page' }).click();
  await first.waitForURL(`${origin}/`);
  assert.equal(await first.getByRole('button', { name: 'Upload', exact: true }).count(), 0);
  await proveInvite(browser, { origin, relay, worker, DB, ownerToken: session.value });
  await DB.prepare('UPDATE drive_sessions SET expires_at = 1 WHERE token_hash = ?').bind(tokenHash).run();
  assert.equal(await privateStatus(), 401);
  assert.equal(await first.evaluate(async () => (await fetch('/api/root-listing/', { redirect: 'error' })).status), 401);
  // Assert the Worker's redirect, not Chromium following it beyond the fixture relay.
  const [expiredPage] = await Promise.all([first.waitForResponse(response =>
    response.url() === origin + target && response.request().isNavigationRequest()), next.click()]);
  assert.equal(expiredPage.status(), 303);
  assert.equal((await expiredPage.allHeaders()).location, `/sign-in?${new URLSearchParams({ next: target })}`);
  await signInFrom(first, target);
  await DB.prepare('UPDATE drive_sessions SET expires_at = ? WHERE token_hash = ?').bind(Date.now() + 60_000, tokenHash).run();
  await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'fixture-owner'").run();
  assert.equal(await privateStatus(), 401);
  await signInFrom(second, '/?revoked=1');
  await primary(second).click();
  await second.getByRole('heading', { name: 'Your access is turned off' }).waitFor();
  assert.deepEqual(traffic.at(-1), ['verify', 403]);
  await DB.prepare('UPDATE drive_credentials SET counter = 0 WHERE id = ?').bind(credential.id).run();
  const challenge = await post('challenge');
  const forged = await fixture('authentication', { key, origin, rpID, challenge: (await challenge.json()).challenge, badSignature: true });
  const denial = await post('verify', { cookie: challenge.headers.get('set-cookie').split(';')[0] }, JSON.stringify(forged.authentication));
  assert.equal(denial.status, 401);
  assert.deepEqual(await denial.json(), { code: 'denied' });
  assert.equal(denial.headers.has('set-cookie'), false);
  console.log('Generated Worker + Chromium + D1: cross-site navigation, restart, queued tabs, late cancel, return targets, expiry and revocation passed');
  await proveOwnerEnrollment(browser);
} finally {
  await browser?.close();
  await harness.close();
}

// Run the separate staging-origin scenario only after the original fixture has closed.
await import('./staging-root.mjs');
