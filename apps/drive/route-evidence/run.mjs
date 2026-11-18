import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { firefox } from 'playwright';
import { captureSpeech } from './speech.mjs';

const { EVIDENCE, PROJECTION, FIREFOX_EXE } = process.env;
const save = (name, data) => writeFile(join(EVIDENCE, `${name}.json`), JSON.stringify(data, null, 2));
const selfCheck = process.env.GITHUB_EVENT_NAME === 'pull_request';
assert(selfCheck || PROJECTION, 'Exact-head run requires a prepared route projection');
const options = { host: '127.0.0.1', port: 0 };
async function serve() {
  if (selfCheck) {
    const server = createServer((request, response) => response.setHeader('content-type', 'text/html').end(
      request.url === '/next'
        ? '<!doctype html><html lang="en"><title>New document</title><main><h1>New document</h1></main>'
        : '<!doctype html><html lang="en"><title>Speech smoke</title><main><p>Introduction</p><h1>Route evidence self-check</h1><a href="/next">Next document</a></main>'
    ));
    await new Promise(resolve => server.listen(options, resolve));
    return { server, close: () => new Promise(resolve => server.close(resolve)) };
  }
  process.chdir(PROJECTION);
  const { build, preview } = await import(pathToFileURL(resolve('node_modules/vite/dist/node/index.js')));
  await build();
  const app = await preview({ preview: options });
  return { server: app.httpServer, close: () => app.close() };
}

function focus(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      label: el.textContent.trim(), visible: el.matches(':focus-visible') && style.outlineStyle !== 'none' &&
        parseFloat(style.outlineWidth) > 0 && rect.top >= 0 && rect.bottom <= innerHeight &&
        el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    };
  });
}

async function inspect(context, page, origin) {
  const states = {
    populated: ['/f/populated', 'Project records', ['Archive notes', 'Next page']],
    empty: ['/f/archive', 'Archive notes', []],
    pastEnd: [null, 'Project records', ['First page']],
    denied: ['/f/denied', "This folder isn't available.", []],
    missing: ['/f/missing', "This folder isn't available.", []],
    signedOut: ['/f/populated', "This folder isn't available.", []]
  };
  await page.goto(`${origin}/f/populated`);
  const next = new URL(await page.getByRole('link', { name: 'Next page' }).getAttribute('href'), page.url());
  states.pastEnd[0] = next.pathname + next.search;
  for (const [state, [url, heading, tabs]] of Object.entries(states)) {
    if (state === 'signedOut') await context.clearCookies();
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      await page.setViewportSize({ width, height });
      await page.goto(origin + url);
      assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), heading);
      if (state === 'empty') assert.equal(await page.getByRole('heading', { level: 2 }).textContent(), 'This folder is empty.');
      if (state === 'pastEnd') assert(await page.getByText('No more items.').isVisible());
      if (['denied', 'missing', 'signedOut'].includes(state)) {
        assert.equal(await page.title(), 'Folder unavailable · Drive');
        assert.equal((await page.locator('main').innerText()).trim(), "This folder isn't available.");
        assert(!/Synthetic title that must not leak|Project records/.test(await page.content()));
      }
      await page.addScriptTag({ path: fileURLToPath(new URL('./node_modules/axe-core/axe.min.js', import.meta.url)) });
      const axe = await page.evaluate(() => window.axe.run({ runOnly: { type: 'tag', values: [
        'wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'
      ] } }));
      await save(`axe-${state}-${width}`, axe);
      await page.screenshot({ path: join(EVIDENCE, `${state}-${width}.png`), fullPage: true });
      assert.equal(axe.violations.length, 0, `axe violations: ${state} ${width}`);
      const actual = [];
      for (const label of tabs) {
        await page.keyboard.press('Tab');
        actual.push(await focus(page));
        assert.deepEqual(actual.at(-1), { label, visible: true });
      }
      assert.equal(await page.locator('main :is(a, button, input, select, textarea, [tabindex])').count(), tabs.length);
      await save(`keyboard-${state}-${width}`, actual);
    }
    await page.setViewportSize({ width: 320, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal scroll: ${state}`);
    await page.screenshot({ path: join(EVIDENCE, `${state}-320.png`), fullPage: true });
    await page.addStyleTag({ content: 'html { filter: grayscale(1) }' });
    await page.screenshot({ path: join(EVIDENCE, `${state}-greyscale.png`), fullPage: true });
    await page.reload();
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    assert(await page.evaluate(() => matchMedia('(forced-colors: active)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches));
    if (tabs.length) {
      await page.keyboard.press('Tab');
      assert.deepEqual(await focus(page), { label: tabs[0], visible: true });
    }
    await page.screenshot({ path: join(EVIDENCE, `${state}-forced-colors.png`), fullPage: true });
    const moving = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length);
    assert.equal(moving, 0, `Animations in reduced motion: ${state}`);
    await page.emulateMedia({ forcedColors: null, reducedMotion: null });
  }
}

const app = await serve();
let browser;
try {
  const origin = `http://${options.host}:${app.server.address().port}`;
  browser = await firefox.launch({ executablePath: FIREFOX_EXE, headless: false });
  await save('browser', { firefox: browser.version(), node: process.version, origin });
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  if (!selfCheck) await context.addCookies([{ url: origin, name: 'route-session', value: 'synthetic' }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(origin + (selfCheck ? '/' : '/f/populated'));
  await captureSpeech(page, join(EVIDENCE, 'speech.jsonl'), selfCheck);
  if (!selfCheck) await inspect(context, page, origin);
  await save('result', { kind: selfCheck ? 'runner-self-check' : 'exact-head-route', status: 'captured', visualReview: selfCheck ? 'not applicable' : 'required' });
} finally {
  try { await browser?.close(); } finally { await app.close(); }
}
