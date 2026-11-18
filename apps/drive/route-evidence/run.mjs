import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { firefox } from 'playwright';
import { captureSpeech } from './speech.mjs';
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
      const stop = await page.evaluate(() => {
        const el = document.activeElement;
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { label: el.textContent.trim(), visible: el.matches(':focus-visible') && style.outlineStyle !== 'none' &&
          parseFloat(style.outlineWidth) > 0 && !/transparent|, 0\)$/.test(style.outlineColor) &&
          r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
      });
      await shot(`${name}-focus-${stops.length + 1}`);
      stops.push(stop);
      assert.deepEqual(stop, { label, visible: true });
    }
    await save(`keyboard-${name}`, stops);
  }
  await page.addInitScript(() => {
    for (const event of ['animationstart', 'transitionrun']) addEventListener(event, () => { window.routeMotionObserved = true; }, true);
  });
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
      assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), heading);
      if (state === 'empty') assert.equal(await page.getByRole('heading', { level: 2 }).textContent(), 'This folder is empty.');
      if (state === 'pastEnd') assert(await page.getByText('No more items.').isVisible());
      if (heading === unavailable) {
        assert.equal(await page.title(), 'Folder unavailable · Drive');
        assert.equal((await page.locator('main').innerText()).trim(), unavailable);
        const outward = await unavailableResponse(response);
        assert(!/Synthetic title that must not leak|Project records/.test(await page.content()));
        if (state === 'denied') denied.set(width, outward);
        else assert.deepEqual(outward, denied.get(width), `${state}: unavailable response differs from denied`);
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
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await page.reload();
    assert(await page.evaluate(() => matchMedia('(forced-colors: active)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches));
    await shot(`${state}-forced-colors`);
    await keyboard(`${state}-forced-colors`, tabs);
    assert(await page.evaluate(() => !window.routeMotionObserved && !document.getAnimations().some(a => a.playState === 'running')), `Motion under reduce: ${state}`);
    await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  }
}

let browser;
try {
  const origin = `http://127.0.0.1:${app.httpServer.address().port}`;
  browser = await firefox.launch({ executablePath: FIREFOX_EXE, headless: false });
  await save('browser', { firefox: browser.version(), node: process.version, origin });
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (!selfCheck) await context.addCookies([{ url: origin, name: 'route-session', value: 'synthetic' }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`${origin}/f/populated`);
  await captureSpeech(page, join(EVIDENCE, 'speech.jsonl'), selfCheck);
  if (!selfCheck) await inspect(context, page, origin);
  await save('result', { kind: selfCheck ? 'runner-self-check' : 'exact-head-route', status: 'captured', visualReview: selfCheck ? 'not applicable' : 'required' });
} finally {
  try { await browser?.close(); } finally { await app.close(); }
}
