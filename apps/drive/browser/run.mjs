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
  for (const [width, height] of [[1280, 800], [390, 844]]) for (const variant of ['file', 'folder', 'shared']) {
    const size = `menu-${variant}-${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    page.on('pageerror', error => console.error('Browser page error:', error));
    page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
    page.on('response', response => { if (response.status() >= 400) console.error('Browser response:', response.status(), response.url()); });
    await page.goto(`${origin}/?menu=${variant}`, { waitUntil: 'networkidle' });
    const trigger = page.locator('button[aria-haspopup="menu"]');
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Actions for Sample file' });
    await menu.waitFor();
    const items = menu.getByRole('menuitem');
    const expected = variant === 'shared' ? ['Download', 'Details'] : variant === 'folder' ? ['Share', 'Rename', 'Move', 'Details', 'Delete'] : ['Download', 'Share', 'Rename', 'Move', 'Details', 'Delete'];
    assert.deepEqual(await items.allTextContents().then(values => values.map(value => value.trim())), expected);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await trigger.getAttribute('aria-controls'), await menu.getAttribute('id'));
    assert.equal(await menu.evaluate(el => el.closest('dialog').matches(':modal')), width === 390);
    if (width === 390) {
      const background = page.locator('main > button');
      await background.evaluate(el => el.focus());
      assert.equal(await background.evaluate(el => el === document.activeElement), false, 'Modal must exclude background focus');
      const ax = await context.newCDPSession(page);
      const { nodes } = await ax.send('Accessibility.getFullAXTree');
      await ax.detach();
      assert.equal(nodes.some(node => !node.ignored && node.role?.value === 'button' && node.name?.value === 'Next file'), false, 'Modal must exclude background from accessibility tree');
      const triggerSize = await trigger.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight, icon: el.querySelector('svg').getBoundingClientRect().width }));
      assert.deepEqual(triggerSize, { width: 44, height: 44, icon: 20 });
      const sheet = await menu.evaluate(el => ({ width: el.getBoundingClientRect().width, maxHeight: getComputedStyle(el).maxHeight, backdrop: getComputedStyle(el.parentElement).backgroundColor, blur: getComputedStyle(el.parentElement).backdropFilter }));
      assert.deepEqual(sheet, { width, maxHeight: `${height * 0.9}px`, backdrop: 'rgba(28, 22, 20, 0.94)', blur: 'blur(14px)' });
    }
    assert.equal(await items.first().evaluate(el => el === document.activeElement), true);
    await page.screenshot({ path: resolve(output, `${size}.png`) });
    await page.evaluate(axe);
    const results = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
    await writeFile(resolve(output, `axe-${size}.json`), JSON.stringify(results, null, 2));
    assert.equal(results.violations.length, 0, `axe violations for ${size}: ${JSON.stringify(results.violations)}`);
    await page.keyboard.press('End');
    assert.equal(await items.last().evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await items.first().evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('ArrowUp');
    assert.equal(await items.last().evaluate(el => el === document.activeElement), true);
    await menu.focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await items.last().evaluate(el => el === document.activeElement), true, 'ArrowUp from the menu container must select the last item');
    await menu.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await items.first().evaluate(el => el === document.activeElement), true, 'ArrowDown from the menu container must select the first item');
    await page.keyboard.press('Home');
    await page.keyboard.press('d');
    assert.equal(await page.getByRole('menuitem', { name: 'Details' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    if (width === 390) {
      const ax = await context.newCDPSession(page);
      const { nodes } = await ax.send('Accessibility.getFullAXTree');
      await ax.detach();
      assert(nodes.some(node => !node.ignored && node.role?.value === 'button' && node.name?.value === 'Next file'), 'Closing the modal must restore background to the accessibility tree');
    }
    await page.keyboard.press('ArrowUp');
    assert.equal(await items.last().evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.body.dataset.tabModal), 'false');
    assert.equal(await page.getByRole('button', { name: 'Next file' }).evaluate(el => el === document.activeElement), true);
    await trigger.click();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.body.dataset.tabModal), 'false');
    assert.equal(await page.getByRole('button', { name: 'Sample file', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.getByRole('button', { name: 'Sample file', exact: true }).click({ button: 'right' });
    await menu.waitFor();
    await page.getByRole('menuitem', { name: 'Details' }).focus();
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => document.body.dataset.actionModal), 'false');
    assert.equal(await page.getByText('Details', { exact: true }).count(), 1);
    assert.equal(await menu.count(), 0);
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    assert.equal(await trigger.getAttribute('aria-controls'), null);
    if (width === 390) {
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.style.cssText = 'position:fixed;top:0;left:0;width:80px;height:40px';
        button.onclick = () => { document.body.dataset.underlayActivated = 'true'; };
        document.body.append(button);
      });
      await trigger.click();
      await page.mouse.click(20, 20);
      assert.equal(await menu.count(), 0);
      assert.equal(await page.evaluate(() => document.body.dataset.underlayActivated), undefined);
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    }
    await writeFile(resolve(output, `keyboard-${size}.json`), JSON.stringify({ expected, escape: 'trigger', tab: 'next row', shiftTab: 'row name', contextMenu: true, activated: 'Details', focusAfterActivation: 'trigger' }, null, 2));
    await context.close();
  }
  for (const [width, height] of [[1280, 180], [390, 240], [1280, 800]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?menu=file&clipped`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Actions for Sample file' }).click();
    const menu = page.getByRole('menu', { name: 'Actions for Sample file' });
    const items = menu.getByRole('menuitem');
    assert.equal(await items.count(), 6, `Expected all file actions at ${width}x${height}`);
    for (let i = 0; i < await items.count(); i++) {
      if (i) await page.keyboard.press('ArrowDown');
      const visible = await items.nth(i).evaluate(el => {
        const item = el.getBoundingClientRect();
        const menu = el.closest('[role=menu]').getBoundingClientRect();
        const x = item.left + item.width / 2;
        const y = item.top + item.height / 2;
        return el === document.activeElement && item.top >= menu.top && item.bottom <= menu.bottom && item.top >= 0 && item.bottom <= innerHeight && el.contains(document.elementFromPoint(x, y));
      });
      assert(visible, `Menu item ${i} inaccessible at ${width}x${height}`);
    }
    await page.screenshot({ path: resolve(output, `menu-clipped-${width}x${height}.png`) });
    await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?menu=file`, { waitUntil: 'networkidle' });
    const trigger = page.locator('button[aria-haspopup="menu"]');
    await trigger.evaluate(el => { el.parentElement.parentElement.style.marginTop = '600px'; });
    await trigger.click();
    assert.equal(await page.getByRole('menu').count(), 1);
    await page.setViewportSize({ width: 1280, height: 300 });
    await page.waitForFunction(() => document.querySelector('[aria-haspopup=menu]').getAttribute('aria-expanded') === 'false');
    assert.equal(await page.getByRole('menu').count(), 0);
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await writeFile(resolve(output, 'menu-resize.json'), JSON.stringify({ initial: '1280x800', resized: '1280x300', result: 'closed, focus restored' }));
    await context.close();
  }
  for (const name of ['report  final.txt', '\t']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?menu=file&name=${encodeURIComponent(name)}`, { waitUntil: 'networkidle' });
    const displayName = name.trim() ? name : `${name} (Whitespace-only name)`;
    const label = `Actions for ${displayName}`;
    const trigger = page.locator('button[aria-haspopup="menu"]');
    assert.equal(await trigger.getAttribute('aria-label'), label);
    await trigger.click();
    const menu = page.locator('[role="menu"]');
    assert.equal(await menu.getAttribute('aria-label'), label);
    assert.equal(await menu.locator('..').getAttribute('aria-label'), label);
    const title = menu.locator('.sheet-title');
    assert.equal(await title.textContent(), displayName);
    assert.equal(await title.evaluate(el => getComputedStyle(el).whiteSpace), 'break-spaces');
    if (!name.trim()) assert.equal(await page.getByRole('menu', { name: 'Actions for (Whitespace-only name)' }).count(), 1);
    await context.close();
  }
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?menu=file`, { waitUntil: 'networkidle' });
    const trigger = page.locator('button[aria-haspopup="menu"]');
    await trigger.click();
    await page.setViewportSize({ width: width === 390 ? 1280 : 390, height: 800 });
    await page.waitForFunction(() => document.querySelector('[aria-haspopup=menu]').getAttribute('aria-expanded') === 'false');
    assert.equal(await page.locator('dialog:modal').count(), 0, 'Resize must release modal');
    await trigger.click();
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-unmount-menu'))); await page.waitForFunction(() => !document.querySelector('[aria-haspopup=menu]'));
    assert.equal(await page.locator('dialog:modal').count(), 0, 'Unmount must release modal');
    await page.getByRole('button', { name: 'Next file' }).focus();
    assert.equal(await page.getByRole('button', { name: 'Next file' }).evaluate(el => el === document.activeElement), true);
    await context.close();
  }
  for (const source of ['document', 'ancestor', 'menu']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 180 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?menu=file`, { waitUntil: 'networkidle' });
    const trigger = page.locator('button[aria-haspopup="menu"]');
    await trigger.evaluate((el, source) => {
      if (source === 'document') document.body.style.minHeight = '1000px';
      if (source === 'ancestor') {
        const container = el.closest('main').firstElementChild;
        container.style.cssText = 'height: 100px; overflow: auto';
        const spacer = document.createElement('div');
        spacer.style.height = '500px';
        container.append(spacer);
      }
    }, source);
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Actions for Sample file' });
    await menu.waitFor();
    const scroll = source === 'document' ? page.locator('html') : source === 'ancestor' ? page.locator('main > div').first() : menu;
    const moved = await scroll.evaluate((el, source) => {
      if (source === 'document') { window.scrollTo(0, 50); return window.scrollY; }
      el.scrollTop = 50;
      return el.scrollTop;
    }, source);
    assert(moved > 0, `${source} did not scroll`);
    if (source === 'menu') {
      await page.waitForTimeout(100);
      assert.equal(await menu.count(), 1, 'Internal scrolling must keep the menu open');
    } else {
      await page.waitForFunction(() => document.querySelector('[aria-haspopup=menu]').getAttribute('aria-expanded') === 'false');
      assert.equal(await menu.count(), 0, `${source} scrolling must dismiss the menu`);
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, `${source} must restore focus`);
      const after = await scroll.evaluate((el, source) => source === 'document' ? window.scrollY : el.scrollTop, source);
      assert.equal(after, moved, `${source} focus restoration must not undo scrolling`);
    }
    await writeFile(resolve(output, `menu-scroll-${source}.json`), JSON.stringify({ source, moved, open: source === 'menu', focusRestoredWithoutScrolling: source !== 'menu' }));
    await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 180 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?menu=file`, { waitUntil: 'networkidle' });
    await page.evaluate(() => { document.body.style.minHeight = '1000px'; });
    await page.getByRole('button', { name: 'Actions for Sample file' }).click();
    await page.evaluate(() => {
      const other = document.createElement('button');
      other.id = 'other-focus';
      document.body.append(other);
      other.focus({ preventScroll: true });
      window.scrollTo(0, 50);
    });
    await page.waitForFunction(() => document.querySelector('[aria-haspopup=menu]').getAttribute('aria-expanded') === 'false');
    assert.equal(await page.locator('#other-focus').evaluate(el => el === document.activeElement), true, 'Scroll dismissal must not steal focus');
    assert.equal(await page.evaluate(() => window.scrollY), 50);
    await context.close();
  }
  for (const width of [320, 390, 1280]) {
    const height = width === 1280 ? 800 : 844;
    const prefix = `menu-modes-${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?menu=file${width === 1280 ? '' : '&longName'}`, { waitUntil: 'networkidle' });
    const name = width === 1280 ? 'Sample file' : 'a'.repeat(200);
    await page.getByRole('button', { name: `Actions for ${name}` }).click();
    const menu = page.getByRole('menu', { name: `Actions for ${name}` });
    const reflow = await menu.evaluate(el => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth, menu: el.clientWidth, content: el.scrollWidth }));
    assert(reflow.page <= reflow.viewport && reflow.content <= reflow.menu, `Horizontal overflow: ${JSON.stringify(reflow)}`);
    await page.screenshot({ path: resolve(output, `${prefix}.png`) });
    const greyscale = await page.addStyleTag({ content: 'html, dialog.layer { filter: grayscale(1); }' });
    assert.equal(await page.locator('dialog.layer').evaluate(el => getComputedStyle(el).filter), 'grayscale(1)');
    await page.screenshot({ path: resolve(output, `${prefix}-greyscale.png`) });
    await greyscale.evaluate(el => el.remove());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const motion = await page.evaluate(() => ({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, runningAnimations: document.getAnimations().filter(animation => animation.playState === 'running').length, animatedElements: [...document.querySelectorAll('*')].filter(el => { const style = getComputedStyle(el); return style.animationName !== 'none' || style.transitionDuration.split(',').some(duration => parseFloat(duration) > 0); }).length }));
    assert.deepEqual(motion, { reduced: true, runningAnimations: 0, animatedElements: 0 });
    await page.screenshot({ path: resolve(output, `${prefix}-reduced-motion.png`) });
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    const focused = menu.getByRole('menuitem').first();
    const focus = await focused.evaluate(el => {
      const style = getComputedStyle(el);
      return { active: el === document.activeElement, visible: el.matches(':focus-visible'), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });
    assert(focus.active && focus.visible && focus.outlineStyle !== 'none' && parseFloat(focus.outlineWidth) > 0, `Missing keyboard focus outline: ${JSON.stringify(focus)}`);
    await page.screenshot({ path: resolve(output, `${prefix}-forced-colours-focus.png`) });
    await writeFile(resolve(output, `${prefix}.json`), JSON.stringify({ reflow, motion, forcedColours: true, focused: await focused.innerText(), focus }, null, 2));
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
    assert.equal(await container.getAttribute('aria-label') ?? await container.locator('caption').textContent(), 'Contents of My Drive, folders first, then files, each sorted by name, A to Z (binary order). Times in America/New_York.');
    if (width > 820) assert.equal(await container.getByRole('columnheader', { name: 'Name' }).getAttribute('aria-sort'), 'other');
    assert.equal(await container.getByRole('link').count(), 3);
    assert.equal(await container.getByRole('link', { name: 'Archive' }).getAttribute('href'), '#archive');
    assert.equal(await container.getByRole('link', { name: 'Résumé 2025.pdf' }).getAttribute('href'), '#resume');
    assert.equal(await container.locator('time').count(), 3);
    assert.equal(await container.locator('svg[aria-hidden="true"]').count(), 3);
    assert.equal(await container.getByRole('link', { name: 'Archive' }).locator('..').locator('svg circle').count(), 1);
    assert.equal(await container.getByRole('link', { name: 'Résumé 2025.pdf' }).locator('..').locator('svg path').count(), 2);
    const tag = container.getByText('Shared', { exact: true });
    assert.equal(await tag.count(), 1);
    const tagStyle = await tag.evaluate(el => ({ transform: getComputedStyle(el).textTransform, shadow: getComputedStyle(el).boxShadow }));
    assert.equal(tagStyle.transform, 'uppercase');
    assert.notEqual(tagStyle.shadow, 'none');
    assert.equal(await container.getByRole('link', { name: 'Archive' }).evaluate(el => getComputedStyle(el).fontWeight), '500');
    if (width > 820) {
      assert.equal(await container.getByText('PDF', { exact: true }).count(), 1);
    } else {
      assert.equal(await container.getAttribute('role'), 'list');
      assert.equal(await container.getByRole('listitem').count(), 3);
      const folder = container.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Archive' }) });
      assert.equal((await folder.locator('.details').textContent()).trim(), 'Folder · 14 Nov');
      const row = container.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Résumé 2025.pdf' }) });
      assert.match(await row.locator('.details').textContent(), /^PDF\s*·/);
    }
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
    if (width !== 320) {
      const greyscale = await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });
      await page.screenshot({ path: resolve(output, `${size}-greyscale.png`) });
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
      await page.screenshot({ path: resolve(output, `${size}-reduced-motion.png`) });
      await page.emulateMedia({ forcedColors: 'active' });
      assert.equal(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), true);
      const link = container.getByRole('link', { name: 'Archive' });
      await link.focus();
      assert.equal(await link.evaluate(el => el === document.activeElement), true);
      await page.screenshot({ path: resolve(output, `${size}-forced-colours-focus.png`) });
      await writeFile(resolve(output, `${size}-modes.json`), JSON.stringify({ motion, forcedColours: true, focused: 'Archive' }, null, 2));
    }
    await context.close();
  }
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?listing&whitespace`, { waitUntil: 'networkidle' });
    const container = width > 820 ? page.getByRole('table') : page.getByRole('list');
    const spaces = container.locator('a[data-item-id="spaces"]');
    const tab = container.locator('a[data-item-id="tab"]');
    assert.equal(await spaces.textContent(), 'report  final.txt');
    assert.equal(await spaces.evaluate(el => getComputedStyle(el).whiteSpace), 'break-spaces');
    assert.equal(await tab.textContent(), '\t(Whitespace-only name)');
    assert.equal(await container.getByRole('link', { name: '(Whitespace-only name)', exact: true }).count(), 1);
    const hit = await spaces.evaluate(el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      return { top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom),
        above: el.contains(document.elementFromPoint(x, rect.top + 4)),
        below: el.contains(document.elementFromPoint(x, rect.bottom - 4)) };
    });
    assert.deepEqual(hit, { top: 8, bottom: 8, above: true, below: true });
    await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?listing`, { waitUntil: 'networkidle' });
    await page.getByRole('table').getByRole('link', { name: 'Résumé 2025.pdf' }).focus();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.activeElement?.matches('ul.mobile a') && document.activeElement.textContent === 'Résumé 2025.pdf');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForFunction(() => document.activeElement?.matches('table.desktop a') && document.activeElement.textContent === 'Résumé 2025.pdf');
    await page.getByRole('table').getByRole('link', { name: 'Résumé 2025.pdf' }).evaluate(el => el.blur());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    await page.setViewportSize({ width: 1280, height: 80 });
    await page.getByRole('table').getByRole('link', { name: 'Résumé 2025.pdf' }).focus();
    await page.setViewportSize({ width: 390, height: 80 });
    await page.waitForFunction(() => {
      const el = document.activeElement;
      if (!el?.matches('ul.mobile a') || el.textContent !== 'Résumé 2025.pdf') return false;
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    });
    await page.setViewportSize({ width: 1280, height: 80 });
    await page.waitForFunction(() => {
      const el = document.activeElement;
      if (!el?.matches('table.desktop a') || el.textContent !== 'Résumé 2025.pdf') return false;
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    });
    await context.close();
  }
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?listing&paged`, { waitUntil: 'networkidle' });
    const container = width > 820 ? page.getByRole('table') : page.getByRole('list');
    assert.equal(await container.getByRole('link').count(), 200);
    assert.equal(await page.getByText('200 of 401 shown', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Show 200 more' }).focus();
    await page.screenshot({ path: resolve(output, `listing-footer-default-${width}.png`) });
    await page.keyboard.press('Enter');
    assert.equal(await container.getByRole('link').count(), 400);
    assert.equal(await container.getByRole('link').nth(199).textContent(), 'File 199.txt');
    assert.equal(await container.getByRole('link').nth(200).textContent(), 'File 200.txt');
    assert.equal(await container.getByRole('link').last().textContent(), 'File 399.txt');
    assert.match(await page.getByRole('status').textContent(), /400 of 401 shown\./);
    await page.keyboard.press('Enter');
    assert.equal(await container.getByRole('link').count(), 401);
    assert.equal(await page.getByText('401 of 401 shown', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'All items shown' }).evaluate(el => el === document.activeElement), true);
    if (width > 820) await page.getByRole('button', { name: 'Name' }).click();
    else await page.getByLabel('Sort', { exact: true }).selectOption('desc');
    assert.equal(await container.getByRole('link').count(), 200);
    assert.equal(await container.getByRole('link').first().textContent(), 'File 400.txt');
    assert.match(await page.getByRole('status').textContent(), /Folders first, then files, each sorted by name, Z to A, in binary order\./);
    const sort = width > 820 ? page.getByRole('button', { name: 'Name' }) : page.getByLabel('Sort', { exact: true });
    await sort.focus();
    await page.setViewportSize({ width: width > 820 ? 390 : 1280, height: 844 });
    await page.waitForFunction(() => document.activeElement?.matches('.compact-sort select, button.sort-button') && document.activeElement.getClientRects().length > 0);
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(() => document.activeElement?.matches('.compact-sort select, button.sort-button') && document.activeElement.getClientRects().length > 0);
    await page.screenshot({ path: resolve(output, `listing-paged-${width}.png`) });
    await page.evaluate(axe);
    const results = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
    assert.equal(results.violations.length, 0, `axe violations for paged ${width}: ${JSON.stringify(results.violations)}`);
    await page.goto(`${origin}/?listing&paged&page-error`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Show 200 more' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await container.getByRole('link').count(), 200);
    assert.equal(await page.getByRole('alert').textContent(), "More items didn't load. Check your connection, then try again.");
    assert.equal(await page.getByRole('button', { name: 'Try again' }).evaluate(el => el === document.activeElement), true);
    await page.getByRole('alert').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(output, `listing-footer-error-${width}.png`) });
    await page.keyboard.press('Enter');
    assert.equal(await container.getByRole('link').count(), 400);
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Show 200 more' }).evaluate(el => el === document.activeElement), true);
    await page.goto(`${origin}/?listing&paged&unknown-total`, { waitUntil: 'networkidle' });
    assert.equal(await page.getByText('200 shown', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Show 200 more' }).click();
    assert.equal(await page.getByText('400 shown', { exact: true }).count(), 1);
    assert.match(await page.getByRole('status').textContent(), /400 shown\./);
    assert.equal(await container.getByRole('link').nth(200).textContent(), 'File 200.txt');
    await page.goto(`${origin}/?listing&paged&page-pending`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Show 200 more' }).click();
    const pending = page.getByRole('button', { name: 'Showing more…' });
    assert.equal(await pending.getAttribute('aria-busy'), 'true');
    assert.equal(await pending.getAttribute('aria-disabled'), 'true');
    await pending.evaluate(el => el.click());
    assert.equal(await page.locator('output').getAttribute('data-page-requests'), '1');
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-page-complete')));
    assert.equal(await container.getByRole('link').count(), 400);
    if (width <= 820) {
      await page.goto(`${origin}/?listing&paged&reject-sort`, { waitUntil: 'networkidle' });
      const select = page.getByLabel('Sort', { exact: true });
      await select.selectOption('desc');
      assert.equal(await select.inputValue(), 'asc');
      assert.equal(await container.getByRole('link').first().textContent(), 'File 000.txt');
    }
    await context.close();
  }
  await writeFile(resolve(output, 'head.txt'), `${head}\n`);
  for (const name of ['head.txt', ...[1280, 390].flatMap(width => [`listing-footer-default-${width}.png`, `listing-footer-error-${width}.png`]), ...states.flatMap(state => [1280, 390].flatMap((width, i) => {
    const size = `${state}-${width}x${[800, 844][i]}`;
    return [`${size}.png`, `axe-${size}.json`, `keyboard-${size}.json`];
  }))]) assert((await stat(resolve(output, name))).size > 0, `Missing evidence: ${name}`);
} finally {
  await browser?.close();
  await server.close();
}
