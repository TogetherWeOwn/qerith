import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtempDisposable, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { fillStorageSettings } from '../browser/owner-storage.mjs';
import { firstReleaseBuildDigest } from '../scripts/first-release-build-digest.mjs';
import { Sessions } from '../src/lib/server/identity/sessions.ts';
import { fixture } from './ceremony-fixture.ts';
import { withStorageSettingsMinio } from './fixtures/storage-settings-minio.mjs';

const { chromium } = createRequire(new URL('../browser/package.json', import.meta.url))('playwright');
const origin = 'https://drive-owner-storage.example.test';
const api = '/api/owner/storage';
const settingsPage = '/settings/storage';
const sessionName = '__Host-drive-session';
const bucket = 'qerith-owner-storage-browser';
const clientVersion = 'RELEASE.2025-08-13T08-35-41Z';
const clientDigest = '01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891';

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

async function createReplacementKey(dir, settings) {
  const mc = join(dir, 'mc');
  execFileSync('curl', ['--disable', '--fail', '--silent', '--location', '--proto', '=https',
    '--proto-redir', '=https', '--max-time', '90', '--max-filesize', '50000000', '--output', mc,
    `https://github.com/minio/mc/releases/download/${clientVersion}/mc.linux-amd64.${clientVersion}`],
  { stdio: 'ignore', timeout: 95_000 });
  assert.equal(hash(await readFile(mc)), clientDigest, 'MinIO client digest');
  await chmod(mc, 0o500);
  const caDir = join(dir, 'mc-config', 'certs', 'CAs');
  await mkdir(caDir, { recursive: true, mode: 0o700 });
  await writeFile(join(caDir, 'fixture.crt'), await readFile(join(dir, 'certs', 'public.crt')), { mode: 0o600 });
  const local = new URL(settings.endpoint);
  assert.equal(local.hostname, '127.0.0.1');
  local.username = settings.accessKeyId;
  local.password = settings.secretAccessKey;
  try {
    const raw = execFileSync(mc, ['--config-dir', join(dir, 'mc-config'), '--json', 'admin', 'accesskey', 'create', 'fixture/'],
      { encoding: 'utf8', env: { HOME: process.env.HOME, MC_HOST_fixture: local.href, MC_DISABLE_PAGER: '1' },
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
    const { accessKey, secretKey, status } = JSON.parse(raw);
    assert(status === 'success' && typeof accessKey === 'string' && typeof secretKey === 'string');
    return { accessKeyId: accessKey, secretAccessKey: secretKey };
  } catch (error) {
    const output = String(error.stdout ?? '');
    const categories = ['certificate', 'Access Denied', 'alias', 'credentials', 'connection refused']
      .filter(category => output.toLowerCase().includes(category.toLowerCase()));
    throw new Error(`Disposable MinIO replacement key creation failed (${categories.join(', ') || error.name})`);
  }
}

async function bootstrap(send, bootstrapToken) {
  const enrollment = '/api/deployer/owner-enrollment';
  const authorize = { authorization: `Bearer ${bootstrapToken}` };
  const challenge = await send(enrollment, 'POST', { operation: 'challenge' }, authorize);
  assert.equal(challenge.status, 200);
  const { options } = await challenge.json();
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rpID = new URL(origin).hostname;
  const { registration } = await fixture('registration', {
    key, origin, rpID, challenge: options.challenge, credentialId: randomBytes(16),
  });
  const enrolled = await send(enrollment, 'POST', { operation: 'enroll', challenge: options.challenge, response: registration }, authorize);
  assert.equal(enrolled.status, 200);
  assert.equal((await enrolled.json()).ok, true);
  return {
    credentialId: Buffer.from(registration.id, 'base64url').toString('base64'), rpId: rpID,
    privateKey: Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)).toString('base64'),
    userHandle: Buffer.from(options.user.id, 'base64url').toString('base64'), isResidentCredential: true, signCount: 1,
  };
}

async function proveBrowser(worker, db, storage, replacement, bootstrapToken) {
  const send = (path, method = 'GET', body, headers = {}) => worker.dispatchFetch(origin + path, {
    method, headers: { origin, 'sec-fetch-site': 'same-origin', ...(body && { 'content-type': 'application/json' }), ...headers },
    body: body && JSON.stringify(body), redirect: 'manual',
  });
  const credential = await bootstrap(send, bootstrapToken);
  await db.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('synthetic-member', 'member', 'active')").run();
  const { token: memberToken } = await new Sessions(db).issue('synthetic-member');
  const member = { cookie: `${sessionName}=${memberToken}` };
  for (const [headers, pageStatus, apiStatus] of [[{}, 401, 401], [member, 404, 403]]) {
    const page = await send(settingsPage, 'GET', undefined, headers);
    assert.equal(page.status, pageStatus);
    assert.equal(page.headers.get('cache-control'), 'private, no-store');
    for (const [path, method] of [[api, 'GET'], [api, 'PUT'], [api + '/test', 'POST']]) {
      const denied = await send(path, method, method === 'GET' ? undefined : {}, headers);
      assert.equal(denied.status, apiStatus);
      assert.equal(denied.headers.get('cache-control'), 'private, no-store');
    }
  }

  const browser = await chromium.launch({ ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    context.setDefaultTimeout(15_000);
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      const headers = await request.allHeaders();
      if (request.isNavigationRequest()) {
        headers['sec-fetch-mode'] = 'navigate';
        headers['sec-fetch-dest'] = 'document';
      }
      const body = request.postDataBuffer();
      if (body) headers['content-length'] ??= String(body.length);
      const response = await worker.dispatchFetch(url, { method: request.method(), headers, body, redirect: 'manual' });
      const payload = Buffer.from(await response.arrayBuffer());
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: payload });
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
    await page.goto(origin + '/sign-in');
    await Promise.all([page.waitForURL(origin + '/'), page.getByRole('button', { name: 'Sign in with a passkey' }).click()]);
    const session = (await context.cookies(origin)).find(cookie => cookie.name === sessionName);
    assert(session?.httpOnly && session.secure, 'protected owner session');
    const owner = { cookie: `${sessionName}=${session.value}` };
    for (const [path, method] of [[api, 'GET'], [api, 'PUT'], [api + '/test', 'POST']]) {
      const denied = await send(path, method, method === 'GET' ? undefined : {},
        { ...owner, origin: 'https://cross-origin.example.test', 'sec-fetch-site': 'cross-site' });
      assert.equal(denied.status, 403);
    }
    const unavailable = await send('/api/uploads', 'POST', { size: 1 }, owner);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: 'storage_unconfigured' });
    assert.equal(await page.getByRole('button', { name: 'Upload', exact: true }).count(), 0);
    await page.getByText('File uploads and downloads are unavailable', { exact: false }).waitFor();
    await page.getByRole('link', { name: 'Storage settings' }).click();
    await page.getByRole('heading', { name: 'Storage unconfigured' }).waitFor();
    const main = page.getByRole('main');
    const readSaved = async () => {
      const response = await send(api, 'GET', undefined, owner);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      const payload = await response.text();
      assert(![storage.secretAccessKey, replacement.secretAccessKey].some(secret => payload.includes(secret)),
        'readback excludes both provider secrets');
      return JSON.parse(payload);
    };
    const unconfigured = { status: 'unconfigured', revision: null, config: null };
    assert.deepEqual(await readSaved(), unconfigured);
    const candidate = { endpoint: storage.endpoint, bucket, region: storage.region,
      accessKeyId: storage.accessKeyId, pathStyle: true };
    const secret = page.getByLabel('Secret access key', { exact: true });
    const test = page.getByRole('button', { name: 'Test connection' });
    const save = page.getByRole('button', { name: 'Save settings' });
    await fillStorageSettings(page, candidate);
    await secret.fill(storage.secretAccessKey);
    await test.click();
    await main.getByText('Connection verified.', { exact: false }).waitFor();
    assert.deepEqual(await readSaved(), unconfigured);
    await save.click();
    const connected = page.getByRole('heading', { name: 'Connected', exact: true }).locator('..');
    await connected.waitFor();
    assert(await secret.evaluate(input => input.value === ''));
    const first = await readSaved();
    assert.equal(first.status, 'connected');
    assert.deepEqual(first.config, candidate);

    await secret.fill(randomBytes(24).toString('hex'));
    await test.click();
    await main.getByText('Connection failed.', { exact: false }).waitFor();
    await connected.getByText(storage.accessKeyId, { exact: true }).waitFor();
    assert.deepEqual(await readSaved(), first);
    await save.click();
    await main.getByText('Storage settings saved.').waitFor();
    const edited = await readSaved();
    assert.notEqual(edited.revision, first.revision);
    assert.deepEqual(edited.config, candidate);
    await page.getByLabel('Access key ID', { exact: true }).fill(replacement.accessKeyId);
    await secret.fill(replacement.secretAccessKey);
    await save.click();
    await connected.getByText(replacement.accessKeyId, { exact: true }).waitFor();
    const rotated = await readSaved();
    assert.notEqual(rotated.revision, edited.revision);
    assert.deepEqual(rotated.config, { ...candidate, accessKeyId: replacement.accessKeyId });
    assert(await secret.evaluate(input => input.value === ''));

    await page.reload();
    await connected.waitFor();
    assert(await secret.evaluate(input => input.value === ''));
    const documentText = await page.content();
    assert(![storage.secretAccessKey, replacement.secretAccessKey].some(secret => documentText.includes(secret)));
    await page.getByRole('link', { name: 'My Drive' }).click();
    const upload = page.getByRole('button', { name: 'Upload', exact: true });
    await upload.and(page.locator('[aria-disabled="false"]')).waitFor();
    const file = { name: 'owner-storage-proof.bin', mimeType: 'application/octet-stream', buffer: randomBytes(257) };
    await page.locator('input[type="file"]').setInputFiles(file);
    const row = page.getByRole('link', { name: file.name, exact: true });
    await row.waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), row.click()]);
    assert.equal(download.suggestedFilename(), file.name);
    assert.equal(hash(await readFile(await download.path())), hash(file.buffer));
    await context.clearCookies();
    await page.goto(origin + '/sign-in?' + new URLSearchParams({ next: settingsPage }));
    await Promise.all([page.waitForURL(origin + settingsPage), page.getByRole('button', { name: 'Sign in with a passkey' }).click()]);
    await page.getByRole('heading', { name: 'Connected', exact: true }).waitFor();
  } finally { await browser.close(); }
}

async function run({ config: storage, outbound }, replacement, head) {
  const config = JSON.parse(await readFile('wrangler.build.jsonc', 'utf8'));
  const bootstrapToken = randomBytes(32).toString('base64url');
  const worker = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.NONE),
    modules: [{ type: 'ESModule', path: resolve('.svelte-kit/first-release-package/_worker.js') }],
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    assets: { ...config.assets, directory: resolve(config.assets.directory), routerConfig: { has_user_worker: true } },
    d1Databases: { DB: randomUUID() },
    bindings: { DRIVE_ORIGIN: origin, DRIVE_FIRST_RELEASE_ORIGIN: origin,
      DRIVE_OWNER_ENROLLMENT_RELEASE: head,
      DRIVE_OWNER_ENROLLMENT: `${head}:${Date.now() + 240_000}:${bootstrapToken}`,
      DRIVE_STORAGE_SETTINGS_KEY: randomBytes(32).toString('base64url'),
    },
    outboundService: request => outbound(request),
  }));
  try {
    const db = await worker.getD1Database('DB');
    for (const name of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(join('migrations', name), 'utf8');
      await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
    }
    await proveBrowser(worker, db, storage, replacement, bootstrapToken);
  } finally { await worker.dispose(); }
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(head, process.env.DRIVE_BUILD_SHA, 'Run alongside the requested exact Worker build');
const version = JSON.parse(await readFile('.svelte-kit/cloudflare/_app/version.json', 'utf8'));
assert.equal(version.version, head, 'Built assets must match the requested commit');
const digest = await firstReleaseBuildDigest();
await using dir = await mkdtempDisposable(join(tmpdir(), 'qerith-owner-storage-minio-'));
await withStorageSettingsMinio(dir.path, bucket, async storage => {
  const replacement = await createReplacementKey(dir.path, storage.minio.settings);
  await run(storage, replacement, head);
});
assert.equal(await firstReleaseBuildDigest(), digest, 'Worker package changed during the proof');
console.log(`Owner storage browser proof passed at ${head}: bootstrap, admission, setup, failed test, retained and rotated keys, and byte-identical file round trip.`);
console.log(`Worker and assets digest: ${digest}`);
