import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { firefox } from 'playwright';
import { assertFreshArrivals, routes } from './arrival-diagnostic.mjs';
import { captureFreshArrival, captureSpeech, nvdaAssetVersion } from './speech.mjs';
import { unavailableResponse } from '../scripts/route-evidence-checks.mjs';

const { EVIDENCE, PROJECTION, FIREFOX_EXE } = process.env;
const save = (name, data) => writeFile(join(EVIDENCE, `${name}.json`), JSON.stringify(data, null, 2));
const selfCheck = process.env.GITHUB_EVENT_NAME === 'pull_request';
assert(PROJECTION, 'A prepared route projection is required');
process.chdir(PROJECTION);
const { createBuilder, preview } = await import(pathToFileURL(resolve('node_modules/vite/dist/node/index.js')));
await (await createBuilder()).buildApp();
const app = await preview({ preview: { host: '127.0.0.1', port: 0 } });

async function inspect(context, page, origin) {
  const shot = (name) => page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
  async function keyboard(name, tabs) {
    const stops = [];
    for (const label of tabs) {
      await page.keyboard.press('Tab');
      stops.push(await page.evaluate(() => {
        const el = document.activeElement;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { label: el.textContent.trim(), visible: el.matches(':focus-visible') && style.outlineStyle !== 'none' &&
          parseFloat(style.outlineWidth) > 0 && !/transparent|, 0\)$/.test(style.outlineColor) &&
          r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
      }));
      await shot(`${name}-focus-${stops.length}`);
      assert.deepEqual(stops.at(-1), { label, visible: true });
    }
    await save(`keyboard-${name}`, stops);
  }
  await page.addInitScript(() => {
    for (const event of ['animationstart', 'transitionrun']) addEventListener(event, () => { window.routeMotionObserved = true; }, true);
  });
  async function reducedMotion(state, tabs) {
    const moving = () => page.evaluate(() => !!window.routeMotionObserved || document.getAnimations().some(a => a.pending || a.playState === 'running'));
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
    await page.reload();
    assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce) and (forced-colors: none)').matches));
    if (selfCheck) await page.addStyleTag({ content: 'a { transition: opacity 60s } a:focus-visible { opacity: .5; outline: 2px solid currentColor }' });
    assert(!await moving(), `Startup motion under reduce: ${state}`);
    await keyboard(`${state}-reduced-motion`, tabs);
    assert.equal(await moving(), selfCheck, `Unexpected motion observation under reduce: ${state}`);
    await save(`motion-${state}`, { startupMotion: false, motionAfterTab: selfCheck });
  }
  if (selfCheck) return reducedMotion('self-check', ['New document']);
  await page.goto(`${origin}/f/populated`);
  const next = new URL(await page.getByRole('link', { name: 'Next page' }).getAttribute('href'), page.url());
  const unavailable = "This folder isn't available.";
  const states = {
    populated: ['/f/populated', 'Project records', ['Archive notes', 'Next page']],
    empty: ['/f/archive', 'Archive notes', []],
    pastEnd: [next.pathname + next.search, 'Project records', ['First page']],
    denied: ['/f/denied', unavailable, []], missing: ['/f/missing', unavailable, []], signedOut: ['/f/populated', unavailable, []]
  };
  const denied = new Map();
  for (const [state, [url, heading, tabs]] of Object.entries(states)) {
    if (state === 'signedOut') await context.clearCookies();
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      await page.setViewportSize({ width, height });
      const response = await page.goto(origin + url);
      assert.equal(await response.headerValue('cache-control'), 'private, no-store', state);
      assert.equal(await response.headerValue('referrer-policy'), 'no-referrer', state);
      assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), heading);
      if (state === 'empty') assert.equal(await page.getByRole('heading', { level: 2 }).textContent(), 'This folder is empty.');
      if (state === 'pastEnd') assert(await page.getByText('No more items.').isVisible());
      if (heading === unavailable) {
        assert(await page.title() === 'Folder unavailable · Drive' && (await page.locator('main').innerText()).trim() === unavailable, `Wrong unavailable page: ${state}`);
        const outward = await unavailableResponse(response);
        assert(!/Synthetic title that must not leak|Project records/.test(await page.content()));
        if (state === 'denied') denied.set(width, outward);
        else for (const field of ['status', 'headers', 'body']) assert(isDeepStrictEqual(outward[field], denied.get(width)[field]), `${state} ${width}: unavailable ${field} differs from denied`);
        await save(`unavailable-${state}-${width}`, outward);
      }
      await page.addScriptTag({ path: fileURLToPath(new URL('./node_modules/axe-core/axe.min.js', import.meta.url)) });
      const axe = await page.evaluate(() => window.axe.run({ runOnly: { type: 'tag', values: [
        'wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'
      ] } }));
      await save(`axe-${state}-${width}`, axe);
      await shot(`${state}-${width}`);
      assert.equal(axe.violations.length, 0, `axe violations: ${state} ${width}`);
      assert.equal(await page.locator('main :is(a, button, input, select, textarea, [tabindex])').count(), tabs.length);
      await keyboard(`${state}-${width}`, tabs);
    }
    await page.setViewportSize({ width: 320, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal scroll: ${state}`);
    await shot(`${state}-320`);
    await page.addStyleTag({ content: 'html { filter: grayscale(1) }' });
    await shot(`${state}-greyscale`);
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'no-preference' });
    await page.reload();
    assert(await page.evaluate(() => matchMedia('(forced-colors: active)').matches));
    await shot(`${state}-forced-colors`);
    await keyboard(`${state}-forced-colors`, tabs);
    await reducedMotion(state, tabs);
    await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  }
}

async function configureContext(context, origin) {
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (!selfCheck) await context.addCookies([{ url: origin, name: 'route-session', value: 'synthetic' }]);
}

async function freshArrivalDiagnostic(origin, path, launchOptions) {
  const asset = join(process.env.GUIDEPUP_SCREEN_READERS_PATH, 'nvda', 'all', nvdaAssetVersion);
  const executable = join(asset, 'extracted', 'nvda.exe');
  const config = join(asset, 'sessionUserConfig');
  async function processes() {
    const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'nvda.exe' OR Name = 'firefox.exe'" | Select-Object Name, ProcessId, ExecutablePath)`;
    const { stdout } = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
      { cwd: process.env.RUNNER_TEMP, timeout: 10000, windowsHide: true });
    return JSON.parse(stdout);
  }
  async function assertReset() {
    assert.deepEqual(await processes(), [], 'Expected no existing NVDA or Firefox processes');
    const previousConfig = await lstat(config).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    assert.equal(previousConfig, undefined, 'Old NVDA session config remains');
  }
  async function inspectNVDA() {
    const [reader, ...otherReaders] = (await processes()).filter(process => process.Name.toLowerCase() === 'nvda.exe');
    assert.equal(otherReaders.length, 0, 'Expected exactly one running NVDA');
    assert.equal(reader?.ExecutablePath?.toLowerCase(), executable.toLowerCase(), 'Expected the pinned NVDA process');
    const configHash = createHash('sha256').update(await readFile(join(config, 'nvda.ini'))).digest('hex');
    return { id: reader.ProcessId, configHash };
  }
  const samples = routes.map((route, index) => ({ route, index, destination: `${origin}/f/${route}`, errors: [] }));
  for (const sample of samples) {
    let context;
    let profile;
    try {
      await assertReset();
      sample.reset = true;
      profile = await mkdtemp(join(process.env.RUNNER_TEMP, 'route-firefox-'));
      sample.profile = basename(profile);
      context = await firefox.launchPersistentContext(profile, launchOptions);
      await configureContext(context, origin);
      const [page] = context.pages();
      assert.equal(context.pages().length, 1, 'Expected one foreground Firefox page');
      page.setDefaultTimeout(10000);
      await page.goto(`${origin}/f/populated`);
      await captureFreshArrival(page, path, sample, inspectNVDA);
    } catch (error) { sample.errors.push(error.message); }
    finally {
      try {
        await context?.close();
        await assertReset();
        sample.stopped = true;
        if (profile) await rm(profile, { recursive: true });
      } catch (error) { sample.errors.push(error.message); }
      await save('fresh-arrivals', { kind: 'lifecycle-diagnostic-only', samples });
    }
  }
  assertFreshArrivals(samples, origin);
}

let browser;
try {
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  const path = join(EVIDENCE, 'speech.jsonl');
  const launchOptions = { executablePath: FIREFOX_EXE, headless: false };
  if (selfCheck) await freshArrivalDiagnostic(origin, path, launchOptions);
  browser = await firefox.launch(launchOptions);
  await save('browser', { firefox: browser.version(), node: process.version, origin });
  const context = await browser.newContext();
  await configureContext(context, origin);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`${origin}/f/populated`);
  await captureSpeech(page, path, selfCheck);
  await inspect(context, page, origin);
  assert(!selfCheck, 'Synthetic lifecycle diagnostic only; no qualifying self-check result');
  await save('result', { kind: 'exact-head-route', status: 'captured', visualReview: 'required' });
} finally {
  try { await browser?.close(); } finally { await app.close(); }
}
