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
  await writeFile(resolve(output, 'head.txt'), `${head}\n`);
  for (const name of ['head.txt', ...states.flatMap(state => [1280, 390].flatMap((width, i) => {
    const size = `${state}-${width}x${[800, 844][i]}`;
    return [`${size}.png`, `axe-${size}.json`, `keyboard-${size}.json`];
  }))]) assert((await stat(resolve(output, name))).size > 0, `Missing evidence: ${name}`);
} finally {
  await browser?.close();
  await server.close();
}
