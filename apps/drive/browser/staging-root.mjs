import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempDisposable, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';
import { fixture, userHandle } from '../tests/ceremony-fixture.ts';
import { bindings } from './upload-storage.mjs';

const origin = 'https://qerith-drive-staging.5150.workers.dev';
const rpID = new URL(origin).hostname;
const sessionName = '__Host-drive-session';
const dataPath = '/__data.json';
await using dir = await mkdtempDisposable('../.svelte-kit/staging-root-browser-');
const config = JSON.parse(await readFile('../wrangler.build.jsonc', 'utf8'));
const configPath = resolve(dir.path, 'wrangler.json');
const main = resolve(dir.path, 'relay.mjs');
await writeFile(main, `import worker from ${JSON.stringify(resolve('../.svelte-kit/cloudflare/_worker.js'))};
import { storageFetch } from ${JSON.stringify(resolve('upload-storage.mjs'))};
globalThis.fetch = storageFetch;
export default { fetch(request, env, ctx) {
  const input = new Request(request);
  // Fetch in the local relay replaces Sec-Fetch-Mode. Restore browser navigations only.
  if (input.headers.has('x-fixture-navigation')) {
    input.headers.set('sec-fetch-mode', 'navigate');
    input.headers.set('sec-fetch-dest', 'document');
    input.headers.delete('x-fixture-navigation');
  }
  return worker.fetch(input, env, ctx);
} };`);
await writeFile(configPath, JSON.stringify({ ...config, main,
  assets: { ...config.assets, directory: resolve('..', config.assets.directory) },
  d1_databases: [{ binding: 'DB', database_name: 'staging-root-test', database_id: '00000000-0000-4000-8000-000000000001' }],
}));
const harness = createTestHarness({ workers: [{ configPath, vars: { DRIVE_ORIGIN: origin, ...bindings } }] });
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

  browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
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
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    const headers = await request.allHeaders();
    if (request.isNavigationRequest()) headers['x-fixture-navigation'] = '1';
    const body = request.postDataBuffer();
    if (body) headers['content-length'] ??= String(body.length);
    const response = await worker.fetch(url, { method: request.method(), headers, body, redirect: 'manual' });
    if (response.ok && url.pathname.startsWith('/_app/immutable/')) assets.add(url.pathname);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  await page.goto(origin + redirect.headers.get('location'), { waitUntil: 'networkidle' });
  const signInAssets = new Set(assets);
  await Promise.all([page.waitForURL(origin + '/'), page.getByRole('button', { name: 'Sign in with a passkey' }).click()]);
  const session = (await context.cookies(origin)).find(cookie => cookie.name === sessionName);
  assert.ok(session?.httpOnly && session.secure);
  const cookie = `${sessionName}=${session.value}`;

  const upload = page.getByRole('button', { name: 'Upload', exact: true });
  await upload.and(page.locator('[aria-disabled="false"]')).waitFor();
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
  await DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'owner'").run();
  for (const path of protectedPaths) await deny(path, 401, { cookie });

  await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, 'staging-root-round-trip.json'), JSON.stringify({
    mode: 'staging-origin', signIn: 'passkey', picker: 'Tab then Enter', navigations,
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
