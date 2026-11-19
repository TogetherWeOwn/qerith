import assert from 'node:assert/strict';
import { appendFile, mkdtempDisposable, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeSpeech } from './speech.mjs';

const { EVIDENCE, FIREFOX_EXE, GITHUB_WORKSPACE } = process.env;
const toolRequire = createRequire(new URL('../route-evidence/package.json', import.meta.url));
const { nvda, NVDAKeyCodeCommands: commands, WindowsKeyCodes: key, WindowsModifiers: modifier } = toolRequire('@guidepup/guidepup');
const { firefox } = toolRequire('playwright');
const origin = 'https://drive.example.test';
const id = '00000000-0000-4000-8000-000000000002';
const download = `/api/download/${id}`;
const cursor = `/?page=${id}`;
const source = resolve(GITHUB_WORKSPACE, 'source/apps/drive');
const appRequire = createRequire(join(source, 'package.json'));
const save = (value) => writeFile(join(EVIDENCE, 'capture.json'), JSON.stringify(value, null, 2));

async function fixtureSession(worker, db) {
  const { fixture, userHandle } = await import(pathToFileURL(join(source, 'tests/ceremony-fixture.ts')));
  const post = (step, extra, body) => worker.fetch(`${origin}/api/sign-in/${step}`, {
    method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/json', ...extra }, body,
  });
  const response = await post('challenge');
  assert.equal(response.status, 200, 'fixture challenge');
  const transaction = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert(transaction?.startsWith('__Host-drive-login='), 'fixture transaction cookie missing');
  const { challenge, rpId } = await response.json();
  assert.equal(rpId, new URL(origin).hostname);
  // Same signed assertion seam as the Drive sign-in HTTP tests. The Worker still verifies and issues the session.
  const { credential, authentication } = await fixture('authentication', { challenge, origin, rpID: rpId });
  await db.prepare(`INSERT INTO drive_principals (id, role, status, webauthn_user_handle)
    VALUES ('fixture-owner', 'owner', 'active', ?)`).bind(userHandle).run();
  await db.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
    VALUES (?, 'fixture-owner', ?, 0, '[]', ?)`).bind(credential.id, Array.from(credential.publicKey), userHandle).run();
  const verified = await post('verify', { cookie: transaction }, JSON.stringify(authentication));
  assert.equal(verified.status, 204, 'fixture signature verification');
  const session = verified.headers.get('set-cookie');
  const value = /^__Host-drive-session=([A-Za-z0-9_-]{43}); Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/.exec(session)?.[1];
  assert(value, 'fixture session cookie missing or malformed');
  return { value, transaction: transaction.slice(transaction.indexOf('=') + 1), challenge };
}

let phase = 'create disposable Worker';
async function capture() {
  assert(!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN, 'Unexpected GitHub token in capture');
  // Follow the reviewed browser/sign-in.mjs layout, including the fixture-only
  // navigation relay (the test Fetch implementation rewrites Sec-Fetch-Mode).
  process.chdir(join(source, 'browser'));
  const { createTestHarness, unstable_splitSqlQuery } = appRequire('wrangler');
  await using dir = await mkdtempDisposable('../.svelte-kit/root-nvda-');
  const config = JSON.parse(await readFile('../wrangler.build.jsonc', 'utf8'));
  const configPath = resolve(dir.path, 'wrangler.json');
  const main = resolve(dir.path, 'navigation.mjs');
  await writeFile(main, `import worker from ${JSON.stringify(resolve('../.svelte-kit/cloudflare/_worker.js'))};
export default { fetch(request, env, ctx) {
  const input = new Request(request);
  if (input.headers.has('x-fixture-navigation')) input.headers.set('sec-fetch-mode', 'navigate');
  input.headers.delete('x-fixture-navigation');
  return worker.fetch(input, env, ctx);
} };`);
  await writeFile(configPath, JSON.stringify({ ...config, main,
    assets: { ...config.assets, directory: resolve('..', config.assets.directory) },
    d1_databases: [{ binding: 'DB', database_name: 'root-nvda-fixture', database_id: '00000000-0000-4000-8000-000000000001' }],
  }));
  const harness = createTestHarness({ workers: [{ configPath, vars: { DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' } }] });
  let browser;
  try {
    await harness.listen();
    const worker = harness.getWorker();
    const { DB } = await worker.getEnv();
    phase = 'apply local D1 migrations';
    for (const name of (await readdir('../migrations')).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(`../migrations/${name}`, 'utf8');
      await DB.batch(unstable_splitSqlQuery(sql).map(statement => DB.prepare(statement)));
    }
    phase = 'sign in to the generated Worker';
    const session = await fixtureSession(worker, DB);
    phase = 'launch contained Firefox';
    browser = await firefox.launch({ executablePath: FIREFOX_EXE, headless: false,
      // Intercepted requests never reach the network. Unintercepted browser traffic has no external proxy or fallback.
      proxy: { server: 'http://127.0.0.1:1' },
      firefoxUserPrefs: { 'network.proxy.failover_direct': false, 'media.peerconnection.enabled': false },
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await context.addCookies([{ url: origin, name: '__Host-drive-session', value: session.value, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const allowed = url.pathname === '/' || url.pathname === download || /^\/_app\/immutable\/[\w./-]+\.(css|woff2)$/.test(url.pathname);
      if (url.origin !== origin || request.method() !== 'GET' || !allowed) return route.abort();
      const headers = await request.allHeaders();
      if (request.isNavigationRequest()) headers['x-fixture-navigation'] = '1';
      const response = await worker.fetch(url, { method: 'GET', headers, redirect: 'manual' });
      const location = response.headers.get('location');
      if (location && (url.pathname !== download || !/^\/\?download=[a-f0-9-]{36}$/.test(location))) return route.abort();
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(10000);
    await captureSpeech(page, DB, session);
    const tools = toolRequire('./package.json').devDependencies;
    return { node: process.version, firefox: browser.version(), playwright: tools.playwright, guidepup: tools['@guidepup/guidepup'] };
  } finally {
    try { await browser?.close(); } finally { await harness.close(); }
  }
}

async function captureSpeech(page, db, session) {
  const press = (code, ...modifiers) => nvda.perform({ keyCode: [code], modifiers }, { capture: true });
  const top = () => press(key.Home, modifier.Control);
  const spoken = new Set();
  let state;
  async function hear(step, action) {
    phase = `${state}: ${step}`;
    await nvda.clearSpokenPhraseLog();
    try { await action(); }
    finally {
      const url = new URL(page.url());
      assert(url.origin === origin && url.pathname === '/', 'Firefox left the generated root');
      const phrases = [...await nvda.spokenPhraseLog()];
      // Discard the entire record if a phrase contains an opaque value, URL or runner-local path.
      assert(safeSpeech(phrases, [session.value, session.transaction, session.challenge]), 'Unpublishable NVDA phrase');
      if (phrases.some(phrase => phrase.trim())) spoken.add(state);
      await appendFile(join(EVIDENCE, 'speech.jsonl'), JSON.stringify({ route: '/', state, width: page.viewportSize().width, step, phrases }) + '\n');
    }
  }
  async function open(next, path = '/', heading = 'My Drive') {
    state = next;
    phase = `${state}: open generated root`;
    const response = await page.goto(origin + path);
    assert.equal(await response.headerValue('cache-control'), 'private, no-store');
    await page.getByRole('heading', { level: 1, name: heading, exact: true }).waitFor();
  }
  async function browse() {
    await page.bringToFront();
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    // Restore browse mode after programmatic navigation (NVDA #5758).
    for (const name of ['readNextFocusableItem', 'toggleBetweenBrowseAndFocusMode', 'toggleBetweenBrowseAndFocusMode', 'exitFocusMode']) {
      await nvda.perform(commands[name], { capture: false });
    }
  }
  const enter = match => Promise.all([page.waitForURL(match, { waitUntil: 'domcontentloaded' }), nvda.act({ capture: true })]);

  await open('empty');
  await page.getByRole('heading', { name: 'Your drive is empty.', exact: true }).waitFor();
  phase = 'start NVDA';
  try {
    await nvda.start({ capture: 'initial', restoreUserScreenReader: false });
    await browse();
    await hear('Control+Home (main and heading)', top);
    await hear('H (next heading)', () => press(key.H));

    await db.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes)
      VALUES (?, 'fixture-owner', 'Résumé 2026.pdf', 'file', 'synthetic-root-object', 1)`).bind(id).run();
    await open('desktop listing');
    await page.getByRole('table').waitFor();
    await browse();
    await hear('Control+Home (main and heading)', top);
    await hear('T (table)', () => press(key.T));
    await hear('Control+Alt+Down (file row)', () => press(key.Down, modifier.Control, modifier.Alt));
    await hear('Control+Alt+Right (kind cell)', () => press(key.Right, modifier.Control, modifier.Alt));
    await top();
    await hear('Tab (download link)', () => press(key.Tab));
    assert.equal(await page.locator(':focus').getAttribute('href'), download);
    state = 'download failure';
    await hear('Enter (download and returned document)', () => enter(url => url.origin === origin && url.pathname === '/' && url.searchParams.has('download')));
    await page.getByRole('alert').waitFor();
    await browse();
    await hear('Control+Home (returned alert)', top);
    await hear('Down (download notice)', () => press(key.Down));

    await page.setViewportSize({ width: 390, height: 844 });
    await open('compact listing');
    await page.getByRole('list').waitFor();
    await browse();
    await hear('Control+Home (main and heading)', top);
    await hear('L (list)', () => press(key.L));
    await hear('I (file item)', () => press(key.I));
    await hear('Down (kind)', () => press(key.Down));
    await top();
    await hear('Tab (download link)', () => press(key.Tab));

    await open('invalid page', '/?page=invalid');
    await browse();
    await top();
    await hear('P (invalid page copy)', () => press(key.P));
    await hear('Tab (recovery link)', () => press(key.Tab));
    await hear('Enter (first page document)', () => enter(`${origin}/`));

    const index = await db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'drive_entries_listing_asc'").first();
    await db.prepare('DROP INDEX drive_entries_listing_asc').run();
    try {
      await open('unavailable page', cursor);
      await page.getByRole('link', { name: 'Try again', exact: true }).waitFor();
      await browse();
      await top();
      await hear('P (unavailable copy)', () => press(key.P));
      await hear('Tab (retry link)', () => press(key.Tab));
    } finally {
      await db.prepare(index.sql).run();
    }
    await hear('Enter (retry document)', async () => {
      await Promise.all([page.waitForEvent('domcontentloaded'), nvda.act({ capture: true })]);
      await page.getByText('No more items.', { exact: true }).waitFor();
    });
    assert.equal(spoken.size, 6, 'At least one root state had no usable speech');
  } finally {
    await nvda.stop();
  }
}

try {
  await save({ status: 'started', node: process.version });
  const versions = await capture();
  await save({ status: 'captured; independent UX reading required', ...versions });
} catch {
  // Underlying browser errors may include URLs, cookie data or other runner state.
  await save({ status: 'failed', phase, node: process.version });
  console.error(`My Drive NVDA capture failed at: ${phase}`);
  process.exitCode = 1;
}
