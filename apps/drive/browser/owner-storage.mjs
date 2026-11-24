import assert from 'node:assert/strict';
import { captureAccessibility } from './accessibility.mjs';
import { viewports } from '../../../scripts/browser-registry.mjs';

const api = '/api/owner/storage';
const firstSecret = 'fixture-only-first-key';
const replacementSecret = 'fixture-only-replacement-key';
const config = {
  endpoint: 'https://storage.example.test',
  region: 'us-east-1',
  bucket: 'drive-synthetic',
  accessKeyId: 'fixture-first',
  pathStyle: true,
};

export async function fillStorageSettings(page, settings) {
  for (const [name, value] of [
    ['HTTPS endpoint', settings.endpoint], ['Region', settings.region],
    ['Bucket', settings.bucket], ['Access key ID', settings.accessKeyId],
  ]) await page.getByLabel(name, { exact: true }).fill(value);
  await page.getByRole('checkbox', { name: 'Use path-style addressing' }).setChecked(settings.pathStyle);
}

function mockStorage(origin, context) {
  let saved = { status: 'unconfigured', revision: null, config: null };
  let revision = 0, releaseTest;
  const writes = [];
  const validKeys = new Map([[config.accessKeyId, firstSecret], ['fixture-replacement', replacementSecret]]);
  const holdTest = () => {
    const { promise, resolve } = Promise.withResolvers();
    releaseTest = promise;
    return resolve;
  };
  return {
    writes, holdTest,
    get saved() { return saved; },
    updateRevision() { saved = { ...saved, revision: String(++revision) }; },
    async install() {
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname !== api && url.pathname !== api + '/test') return route.continue();
        const reply = (status, json) => route.fulfill({
          status, headers: { 'cache-control': 'private, no-store' }, json,
        });
        if (request.method() === 'GET' && url.pathname === api) return reply(200, saved);
        const test = request.method() === 'POST' && url.pathname === api + '/test';
        assert(test || (request.method() === 'PUT' && url.pathname === api));
        assert.equal(request.headers()['content-type'], 'application/json');
        const { revision: base, secretAccessKey, ...candidate } = request.postDataJSON();
        assert.deepEqual(Object.keys(candidate).sort(), Object.keys(config).sort());
        writes.push({ test, base, candidate, hasSecret: secretAccessKey !== undefined });
        if (test && releaseTest) {
          await releaseTest;
          releaseTest = undefined;
        }
        if (base !== saved.revision) return reply(409, { error: 'settings_conflict' });
        if (saved.config && ['endpoint', 'region', 'bucket', 'pathStyle'].some(key => candidate[key] !== saved.config[key])) {
          return reply(409, { error: 'storage_location_locked' });
        }
        const expected = validKeys.get(candidate.accessKeyId);
        if (!expected || (secretAccessKey === undefined
          ? candidate.accessKeyId !== saved.config?.accessKeyId
          : secretAccessKey !== expected)) return reply(422, { error: 'connection_failed' });
        if (test) return reply(200, { status: 'verified' });
        saved = { status: 'connected', revision: String(++revision), config: candidate };
        return reply(200, saved);
      });
      await context.routeWebSocket('**/*', socket => socket.close());
    },
  };
}

export async function exercise(browser, origin, axe, output, entry) {
  for (const width of entry.widths) {
    const context = await browser.newContext({ viewport: { width, height: viewports[width] }, serviceWorkers: 'block' });
    try {
      const fixture = mockStorage(origin, context);
      await fixture.install();
      const page = await context.newPage();
      await page.goto(origin + '/?owner-storage');
      const main = page.getByRole('main');
      const test = page.getByRole('button', { name: 'Test connection' });
      const save = page.getByRole('button', { name: 'Save settings' });
      const secret = page.getByLabel('Secret access key', { exact: true });
      const secretEmpty = async () => assert(await secret.evaluate(el => el.value === '' && !el.hasAttribute('name')));
      const capture = state => captureAccessibility(page, {
        id: 'owner-storage', state, width, axe, output,
        keyboard: async () => {
          await save.focus();
          await page.keyboard.press('Shift+Tab');
          assert(await test.evaluate(el => el === document.activeElement && el.matches(':focus-visible')));
          return 'Test connection';
        },
        focusForced: async () => {
          await test.focus();
          assert(await test.evaluate(el => getComputedStyle(el).outlineStyle === 'solid'));
        },
      });
      await page.getByRole('heading', { name: 'Storage unconfigured' }).waitFor();
      await secretEmpty();
      await capture('unconfigured');
      await fillStorageSettings(page, config);
      await test.click();
      assert.equal(fixture.writes.length, 0, 'setup requires a secret');
      await secret.fill(firstSecret);
      await test.press('Enter');
      await main.getByText('Connection verified.', { exact: false }).waitFor();
      assert.equal(fixture.saved.status, 'unconfigured');
      assert.deepEqual(fixture.writes[0], { test: true, base: null, candidate: config, hasSecret: true });
      await save.press('Enter');
      const connected = page.getByRole('heading', { name: 'Connected', exact: true }).locator('..');
      await connected.waitFor();
      await secretEmpty();
      await capture('connected');

      const release = fixture.holdTest();
      await test.click();
      try {
        await main.getByText('Testing connection…').waitFor();
        assert.equal(await save.getAttribute('aria-disabled'), 'true');
        await save.press('Enter');
        assert.equal(fixture.writes.length, 3);
        assert.equal(fixture.writes.at(-1).hasSecret, false);
        await capture('testing');
      } finally { release(); }
      await main.getByText('Connection verified.', { exact: false }).waitFor();

      const saved = fixture.saved;
      const key = page.getByLabel('Access key ID', { exact: true });
      await key.fill('fixture-replacement');
      await save.click();
      assert.equal(fixture.writes.length, 3, 'a different ID requires a replacement secret');
      await secret.fill('fixture-only-wrong-key');
      await test.click();
      await main.getByText('Connection failed.', { exact: false }).waitFor();
      await connected.getByText(config.accessKeyId, { exact: true }).waitFor();
      assert.equal(fixture.saved, saved);
      assert.equal(await key.inputValue(), 'fixture-replacement');
      await secretEmpty();
      await capture('connection-failed');

      fixture.updateRevision();
      await secret.fill(replacementSecret);
      await save.click();
      await main.getByText('Storage settings changed in another session.', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Load latest settings' }).click();
      await main.getByText('Latest settings loaded.', { exact: false }).waitFor();
      assert.equal(await key.inputValue(), 'fixture-replacement');
      await secretEmpty();

      const bucket = page.getByLabel('Bucket', { exact: true });
      await bucket.fill('new-synthetic-bucket');
      await secret.fill(replacementSecret);
      await save.click();
      await page.getByRole('button', { name: 'Use saved destination' }).waitFor();
      assert.equal(await bucket.inputValue(), 'new-synthetic-bucket');
      assert.equal(await key.inputValue(), 'fixture-replacement');
      await connected.getByText(config.bucket, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Use saved destination' }).click();
      assert.equal(await bucket.inputValue(), config.bucket);
      assert.equal(await key.inputValue(), 'fixture-replacement');
      await secret.fill(replacementSecret);
      await page.evaluate(() => dispatchEvent(new Event('pagehide')));
      await secretEmpty();
      await secret.fill(replacementSecret);
      await save.click();
      await connected.getByText('fixture-replacement', { exact: true }).waitFor();
      assert.equal(fixture.writes.at(-1).base, '2');
      await secretEmpty();
      const readback = await page.evaluate(async api => (await fetch(api)).json(), api);
      assert.deepEqual(readback, { status: 'connected', revision: '3', config: { ...config, accessKeyId: 'fixture-replacement' } });
      assert(await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0));
    } finally { await context.close(); }
  }
}
