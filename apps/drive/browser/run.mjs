import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer } from 'vite';
import { exerciseKeyboard, exerciseWaitAnnouncement, states, waitForFixture } from './scenario.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const output = process.env.DRIVE_BROWSER_EVIDENCE_DIR;
const expectedHead = process.env.DRIVE_BROWSER_HEAD;
assert(output && expectedHead, 'Evidence directory and exact head are required');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(head, expectedHead, 'Checkout must equal the requested head');
await mkdir(output, { recursive: true });
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const server = await createServer({
  configFile: false,
  root: resolve(here, 'fixture'),
  tsconfig: resolve(here, 'fixture/tsconfig.json'),
  optimizeDeps: { rolldownOptions: { tsconfig: resolve(here, 'fixture/tsconfig.json') } },
  plugins: [svelte()],
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  logLevel: 'error'
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  for (const [width, height] of [[1280, 800], [390, 844]]) for (const state of states) {
    const size = `${state}-${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    page.on('pageerror', error => console.error('Browser page error:', error));
    page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
    page.on('response', response => { if (response.status() >= 400) console.error('Browser response:', response.status(), response.url()); });
    await page.goto(`${origin}/?state=${state}`, { waitUntil: 'networkidle' });
    await waitForFixture(page, state);
    await page.screenshot({ path: resolve(output, `${size}.png`) });
    await page.evaluate(axe);
    const results = await page.evaluate(() => window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
    }));
    await writeFile(resolve(output, `axe-${size}.json`), JSON.stringify(results, null, 2));
    assert.equal(results.violations.length, 0, `axe violations for ${size}: ${JSON.stringify(results.violations)}`);
    const keyboard = await exerciseKeyboard(page, state);
    const keyboardJson = JSON.stringify(keyboard, null, 2);
    const recordedKeyboard = keyboardJson && JSON.parse(keyboardJson);
    assert(recordedKeyboard && typeof recordedKeyboard === 'object' && Object.keys(recordedKeyboard).length, 'Keyboard evidence is required');
    await writeFile(resolve(output, `keyboard-${size}.json`), keyboardJson);
    if (state === 'sign-in') {
      const viewport = `${width}x${height}`;
      await writeFile(resolve(output, `wait-tree-${viewport}.txt`), await exerciseWaitAnnouncement(page));
      for (const prefix of ['', 'axe-', 'keyboard-']) {
        const extension = prefix ? 'json' : 'png';
        await copyFile(resolve(output, `${prefix}${size}.${extension}`), resolve(output, `${prefix}${viewport}.${extension}`));
      }
    }
    await context.close();
  }
  for (const [width, height] of [[1280, 800], [390, 844]]) for (const empty of ['root', 'folder']) {
    const size = `empty-${empty}-${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?empty=${empty}`, { waitUntil: 'networkidle' });
    const heading = empty === 'root' ? 'Your drive is empty.' : 'This folder is empty.';
    const description = empty === 'root' ? 'Upload a file or make a folder to start.' : 'Drop files here or use Upload.';
    await page.getByRole('heading', { name: heading, level: 2 }).waitFor();
    assert.equal(await page.getByText(description, { exact: true }).count(), 1);
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.locator('.empty').evaluate(el => {
      const style = getComputedStyle(el);
      return { direction: style.flexDirection, padding: style.paddingTop, radius: style.borderTopLeftRadius, border: style.borderTopWidth };
    });
    assert.deepEqual(layout, { direction: width === 390 ? 'column' : 'row', padding: '20px', radius: '10px', border: '1px' });
    assert.equal(await page.evaluate(() => document.fonts.check('16px "Qerith Sans"')), true);
    await page.screenshot({ path: resolve(output, `${size}.png`) });
    await page.evaluate(axe);
    const results = await page.evaluate(() => window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
    }));
    await writeFile(resolve(output, `axe-${size}.json`), JSON.stringify(results, null, 2));
    assert.equal(results.violations.length, 0, `axe violations for ${size}: ${JSON.stringify(results.violations)}`);
    await page.keyboard.press('Tab');
    const button = page.getByRole('button', { name: 'Upload files' });
    assert.equal(await button.evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('output').getAttribute('data-uploads'), '1');
    await writeFile(resolve(output, `keyboard-${size}.json`), JSON.stringify({ focused: 'Upload files', activations: 1 }));
    await context.close();
  }
  for (const empty of ['root', 'folder']) {
    const context = await browser.newContext({ viewport: { width: 320, height: 844 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?empty=${empty}`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: empty === 'root' ? 'Your drive is empty.' : 'This folder is empty.', level: 2 }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const prefix = `empty-${empty}-320x844`;
    const reflow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    assert.equal(reflow.viewport, 320);
    assert(reflow.scrollWidth <= reflow.viewport, `Horizontal page overflow: ${JSON.stringify(reflow)}`);
    await page.screenshot({ path: resolve(output, `${prefix}.png`) });
    const greyscale = await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });
    await page.screenshot({ path: resolve(output, `${prefix}-greyscale.png`) });
    await greyscale.evaluate(el => el.remove());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const motion = await page.evaluate(() => ({
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      runningAnimations: document.getAnimations().filter(animation => animation.playState === 'running').length,
      animatedElements: [...document.querySelectorAll('*')].filter(el => {
        const style = getComputedStyle(el);
        return style.animationName !== 'none' || style.transitionDuration.split(',').some(duration => parseFloat(duration) > 0);
      }).length
    }));
    assert.deepEqual(motion, { reduced: true, runningAnimations: 0, animatedElements: 0 });
    await page.screenshot({ path: resolve(output, `${prefix}-reduced-motion.png`) });
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), true);
    await page.keyboard.press('Tab');
    const button = page.getByRole('button', { name: 'Upload files' });
    assert.equal(await button.evaluate(el => el === document.activeElement), true);
    await page.screenshot({ path: resolve(output, `${prefix}-forced-colours-focus.png`) });
    await writeFile(resolve(output, `${prefix}-modes.json`), JSON.stringify({ reflow, motion, forcedColours: true, focused: 'Upload files' }, null, 2));
    for (const suffix of ['.png', '-greyscale.png', '-reduced-motion.png', '-forced-colours-focus.png', '-modes.json']) {
      assert((await stat(resolve(output, `${prefix}${suffix}`))).size > 0, `Missing evidence: ${prefix}${suffix}`);
    }
    await context.close();
  }
  for (const [width, height] of [[1280, 800], [390, 844], [320, 844]]) {
    const size = `listing-${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?listing`, { waitUntil: 'networkidle' });
    const container = width > 820 ? page.getByRole('table') : page.getByRole('list');
    assert.equal(await container.count(), 1);
    assert.equal(await container.getAttribute('aria-label') ?? await container.locator('caption').textContent(), 'Contents of My Drive, sorted by name, A to Z. Times in America/New_York.');
    if (width > 820) assert.equal(await container.getByRole('columnheader', { name: 'Name' }).getAttribute('aria-sort'), 'ascending');
    assert.equal(await container.getByRole('link').count(), 3);
    assert.equal(await container.getByRole('link', { name: 'Archive' }).getAttribute('href'), '#archive');
    assert.equal(await container.getByRole('link', { name: 'Résumé 2025.pdf' }).getAttribute('href'), '#resume');
    assert.equal(await container.locator('time').count(), 3);
    assert.equal(await container.locator('svg[aria-hidden="true"]').count(), 3);
    assert.equal(await container.getByRole('link', { name: 'Archive' }).locator('..').locator('svg circle').count(), 1);
    assert.equal(await container.getByRole('link', { name: 'Résumé 2025.pdf' }).locator('..').locator('svg path').count(), 2);
    assert.equal(await container.getByText('Shared', { exact: true }).count(), 1);
    assert.equal(await container.locator('data').count(), 2);
    assert.equal(await container.locator('data[value="1000"]').textContent(), '1.0 KB');
    assert.equal(await container.locator('data[value="5400000"]').textContent(), '5.4 MB');
    assert.equal(await container.locator('time[datetime="2026-11-13T09:00:00Z"]').textContent(), '13 Nov');
    assert.equal(await container.getByRole('link', { name: 'Résumé 2025.pdf' }).evaluate(el => getComputedStyle(el).unicodeBidi), 'plaintext');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: resolve(output, `${size}.png`) });
    await page.evaluate(axe);
    const results = await page.evaluate(() => window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
    }));
    await writeFile(resolve(output, `axe-${size}.json`), JSON.stringify(results, null, 2));
    assert.equal(results.violations.length, 0, `axe violations for ${size}: ${JSON.stringify(results.violations)}`);
    for (const name of ['Archive', 'a-very-long-file-name-without-breaks-to-check-reflow.txt', 'Résumé 2025.pdf']) {
      await page.keyboard.press('Tab');
      assert.equal(await container.getByRole('link', { name }).evaluate(el => el === document.activeElement), true);
    }
    await writeFile(resolve(output, `keyboard-${size}.json`), JSON.stringify({ focusOrder: ['Archive', 'long file', 'Résumé 2025.pdf'] }));
    await context.close();
  }
  await writeFile(resolve(output, 'head.txt'), `${head}\n`);
  for (const name of ['head.txt', ...states.flatMap(state => [1280, 390].flatMap((width, i) => {
    const size = `${state}-${width}x${[800, 844][i]}`;
    return [`${size}.png`, `axe-${size}.json`, `keyboard-${size}.json`];
  }))]) assert((await stat(resolve(output, name))).size > 0, `Missing evidence: ${name}`);
} finally {
  await browser?.close();
  await server.close();
}
