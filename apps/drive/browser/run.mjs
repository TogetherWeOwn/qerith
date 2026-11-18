import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer } from 'vite';
import { exerciseKeyboard, exerciseWaitAnnouncement, states, waitForFixture } from './scenario.mjs';

const filenameCases = [
  ['unicode', 'áááááááááááá👩‍👩‍👧‍👦.txt'],
  ['rtl', 'تقرير-الميزانية-السنوية-النهائية.pdf'],
  ['invoice', 'invoice-february.pdf'],
  ['accented-long', 'Résumé-budget-annuel-version-finale.pdf'],
  ['emoji-modifier', 'annual-budget-👍🏽-final-report.pdf'],
  ['emoji-flag', 'annual-budget-🇺🇸-final-report.pdf'],
  ['accented-terminal', 'budget-annuel-résumé.pdf'],
  ['emoji-terminal', 'annual-budget-👍🏽.pdf'],
  ['decomposed', 'Résumé-café-final-report.pdf'],
  ['accented-terminal-long', 'budget-annuel-version-finale-résumé.pdf'],
  ['emoji-terminal-long', 'annual-budget-version-final-report-👍🏽.pdf'],
  ['decomposed-long', 'Résumé-café-version-finale-annual-report.pdf'],
  ['tatweel', 'ب'.repeat(10) + 'ـ' + 'ب'.repeat(5) + '.pdf'],
  ['mixed-bidi', 'تقرير-annual-budget.pdf'],
  ['bidi-control', 'annual-' + String.fromCodePoint(0x202e) + 'budget-report.pdf'],
  ['bidi-digits', 'annual-١٢٣٤٥٦٧٨٩-report.pdf'],
  ['bidi-punctuation', 'annual-־budget-report.pdf'],
  ['bidi-suffix', 'report.' + 'ב'.repeat(20)],
  ['khmer', 'ក'.repeat(10) + 'ក្' + 'ក'.repeat(5) + '.pdf'],
  ['kannada', 'ಕ'.repeat(10) + 'ಕ್' + 'ಕ'.repeat(5) + '.pdf'],
  ['wide-suffix', 'abcdefghijklmnop.' + '界'.repeat(15)],
  ['zwj-modifier', 'annual-👩🏽‍💻-final-report.pdf'],
  ['accent-dot', 'resume-café.pdf'],
  ['ascii-255', 'a'.repeat(251) + '.txt'],
  ['cjk', '年度予算報告書'.repeat(4) + '.pdf'],
  ['edge-spaces', '  leading  and trailing  '],
  ['only-spaces', '   ']
];

async function assertWhitespaceName(link, name) {
  const nodes = await link.evaluate(el => ({
    firstType: el.firstChild?.nodeType,
    firstText: el.firstChild?.textContent,
    annotation: el.querySelector('span')?.textContent
  }));
  assert.equal(nodes.firstType, 3, 'Stored filename must be a text node');
  assert.equal(nodes.firstText, name, 'Stored filename must be preserved exactly');
  assert.equal(nodes.annotation, '(Whitespace-only name)');
  assert.equal(await link.textContent(), name + '(Whitespace-only name)');
}

function observeFontRequests(page) {
  const requests = [];
  page.on('response', response => {
    if (response.request().resourceType() === 'font' && requests.length < 32) requests.push({ url: response.url(), status: response.status() });
  });
  page.on('requestfailed', request => {
    if (request.resourceType() === 'font' && requests.length < 32) requests.push({ url: request.url(), failure: request.failure()?.errorText });
  });
  return requests;
}

async function captureVisibilityFailure(page, link, context) {
  const layout = await link.evaluate(el => {
    const rect = r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height });
    const describe = node => {
      const s = getComputedStyle(node);
      return { tag: node.tagName, className: typeof node.className === 'string' ? node.className : '', bounds: rect(node.getBoundingClientRect()),
        overflowX: s.overflowX, overflowY: s.overflowY, clipPath: s.clipPath, lineClamp: s.webkitLineClamp,
        whiteSpace: s.whiteSpace, overflowWrap: s.overflowWrap, wordBreak: s.wordBreak, unicodeBidi: s.unicodeBidi,
        textOverflow: s.textOverflow, fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
        fontStretch: s.fontStretch, lineHeight: s.lineHeight, zoom: s.zoom, transform: s.transform };
    };
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].map(rect);
    const anchor = describe(el);
    const row = describe(el.closest('li, tr'));
    const chain = [];
    for (let node = el.parentElement; node; node = node.parentElement) chain.push(describe(node));
    const deltas = (r, box) => ({ left: r.left - box.left, right: box.right - r.right, top: r.top - box.top, bottom: box.bottom - r.bottom });
    const fails = edges => Object.fromEntries(Object.entries(edges).map(([edge, delta]) => [edge, delta < -1]));
    const checks = rects.map(r => ({ anchor: { edges: deltas(r, anchor.bounds), failed: fails(deltas(r, anchor.bounds)) },
      row: { edges: deltas(r, row.bounds), failed: fails(deltas(r, row.bounds)) },
      ancestors: chain.map(node => {
        const edges = deltas(r, node.bounds);
        const clipped = ['hidden', 'clip', 'auto', 'scroll'];
        return { tag: node.tag, className: node.className, edges,
          failed: { left: clipped.includes(node.overflowX) && edges.left < -1, right: clipped.includes(node.overflowX) && edges.right < -1,
            top: clipped.includes(node.overflowY) && edges.top < -1, bottom: clipped.includes(node.overflowY) && edges.bottom < -1,
            clipPath: node.clipPath !== 'none', lineClamp: !['none', ''].includes(node.lineClamp) } };
      }) }));
    const cssExpected = { whiteSpace: 'break-spaces', overflowWrap: 'anywhere', wordBreak: 'normal', unicodeBidi: 'plaintext',
      textOverflow: 'clip', overflowX: 'visible', overflowY: 'visible' };
    const failedCss = Object.fromEntries(Object.entries(cssExpected).filter(([key, value]) => anchor[key] !== value));
    const text = el.textContent;
    return { nodeType: el.firstChild?.nodeType, text, codePoints: [...text].map(c => `U+${c.codePointAt(0).toString(16).toUpperCase()}`),
      anchor, row, chain, rects, checks, failedCss, failedNodeType: el.firstChild?.nodeType !== Node.TEXT_NODE,
      failedLineClamp: !['none', ''].includes(anchor.lineClamp), failedEmptyRange: !rects.length, tolerance: 1,
      viewport: { innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
        dpr: devicePixelRatio, visualScale: visualViewport?.scale },
      fonts: [...document.fonts].map(f => ({ family: f.family, style: f.style, weight: f.weight, stretch: f.stretch, unicodeRange: f.unicodeRange, display: f.display, status: f.status })) };
  });
  const fonts = {};
  let session;
  try {
    session = await page.context().newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const anchorSelector = `${context.selector} a[data-item-id="${context.id}"]`;
    const rowSelector = `${context.selector} ${context.selector === 'table.desktop' ? 'tr' : 'li'}:has(a[data-item-id="${context.id}"])`;
    for (const [label, selector] of Object.entries({ anchor: anchorSelector, row: rowSelector, header: `${context.selector} th`, data: `${rowSelector} td:not(:first-child)` })) {
      try {
        const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        fonts[label] = nodeId ? await session.send('CSS.getPlatformFontsForNode', { nodeId }) : { unavailable: 'node not found' };
      } catch (error) { fonts[label] = { unavailable: String(error) }; }
    }
  } catch (error) { fonts.unavailable = String(error); }
  finally { if (session) await session.detach().catch(() => {}); }
  console.error('VISIBILITY_DIAGNOSTIC', JSON.stringify({ context, layout, fonts, fontStateTiming: 'post-failure; font selection may race' }));
}

async function assertFullFilenames(page, selector, context = {}) {
  for (const [id, name] of filenameCases) {
    const link = page.locator(`${selector} a[data-item-id="${id}"]`);
    const label = name.trim() ? name : name + ' (Whitespace-only name)';
    assert.equal(await link.getAttribute('aria-label'), label);
    assert.equal(await page.getByRole('link', { name: label, exact: true }).count(), 1, `${selector} ${id}: computed accessible name`);
    assert.equal(await link.getAttribute('href'), `#${id}`);
    if (name.trim()) assert.equal(await link.textContent(), name);
    else await assertWhitespaceName(link, name);
    try {
      assert.equal(await link.evaluate(el => {
      const nameNode = el.firstChild;
      if (nameNode?.nodeType !== Node.TEXT_NODE) return false;
      const style = getComputedStyle(el);
      if (style.whiteSpace !== 'break-spaces' || style.overflowWrap !== 'anywhere' ||
          style.wordBreak !== 'normal' || style.unicodeBidi !== 'plaintext' ||
          style.textOverflow !== 'clip' || style.overflowX !== 'visible' || style.overflowY !== 'visible' ||
          !['none', ''].includes(style.webkitLineClamp)) return false;
      const bounds = el.getBoundingClientRect();
      const row = el.closest('li, tr').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()];
      if (!rects.length) return false;
      return rects.every(rect => {
        if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1 ||
            rect.left < row.left - 1 || rect.right > row.right + 1 || rect.top < row.top - 1 || rect.bottom > row.bottom + 1) return false;
        for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          const clip = ancestor.getBoundingClientRect();
          if (style.clipPath !== 'none' || !['none', ''].includes(style.webkitLineClamp)) return false;
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX) && (rect.left < clip.left - 1 || rect.right > clip.right + 1)) return false;
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY) && (rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1)) return false;
        }
        return true;
      });
      }), true, `${selector} ${id}: full text must remain visible in one text run`);
    } catch (error) {
      try { await captureVisibilityFailure(page, link, { ...context, selector, id, expectedText: name }); }
      catch (diagnosticError) { console.error('VISIBILITY_DIAGNOSTIC_UNAVAILABLE', String(diagnosticError)); }
      throw error;
    }
  }
}

async function assertListingFonts(page, responses, origin) {
  const faces = await page.evaluate(async () => (await window.fixtureFonts).map(({ url, face }) => ({
    url: new URL(url, document.baseURI).href,
    family: face.family,
    status: face.status,
    registered: document.fonts.has(face),
    weight: face.weight,
    stretch: face.stretch,
    style: face.style,
    display: face.display,
    unicodeRange: face.unicodeRange
  })));
  const expected = await page.evaluate(() => {
    // Let Chromium canonicalize the original CSS descriptors for comparison.
    const unicodeRange = 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2190-2193, U+2212, U+2215, U+FEFF, U+FFFD';
    return [
      new FontFace('Qerith Sans', 'local("unused")', { weight: '200 900', stretch: '75% 125%', display: 'swap', unicodeRange }),
      new FontFace('Fragment Mono', 'local("unused")', { weight: '400', display: 'optional', unicodeRange })
    ].map(({ family, weight, stretch, style, display, unicodeRange }) => ({
      family, status: 'loaded', registered: true, weight, stretch, style, display, unicodeRange
    }));
  });
  assert.deepEqual(faces.map(({ url, ...descriptors }) => descriptors), expected);

  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const assets = { 'Qerith Sans': 'QerithSans-latin.woff2', 'Fragment Mono': 'FragmentMono-Regular-latin.woff2' };
  for (const face of faces) {
    const file = assets[face.family];
    assert.equal(new URL(face.url).origin, origin, `${file}: font must be same-origin`);
    const response = responses.find(response => response.url() === face.url && response.status() === 200);
    assert(response, `${file}: expected a successful browser font response`);
    face.httpStatus = response.status();
    face.sha256 = digest(await response.body());
    assert.equal(face.sha256, digest(await readFile(resolve(here, '../src/lib/fonts', file))), `${file}: response bytes must match the tracked font`);
  }

  const samples = [];
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    // Chromium can decorate the reported family name with its font backend.
    for (const [selector, text, postScriptName] of [
      ['table.desktop a[data-item-id="2"]', 'Résumé 2025.pdf', 'QerithSans-Regular'],
      ['table.desktop th[aria-sort]', 'Name', 'FragmentMono-Regular']
    ]) {
      const sample = page.locator(selector);
      assert.equal(await sample.isVisible(), true, `${text}: must be visible in the desktop fixture`);
      assert.equal(await sample.textContent(), text);
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      assert(nodeId, `${text}: expected a CDP node`);
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      assert(fonts.length > 0 && fonts.every(font => font.postScriptName === postScriptName && font.isCustomFont && font.glyphCount > 0),
        `${text}: expected only custom ${postScriptName}, got ${JSON.stringify(fonts)}`);
      samples.push({ selector, text, fonts });
    }
  } finally {
    await session.detach();
  }
  return { faces, samples };
}

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
  for (const [width, height] of [[1280, 800], [390, 844], [320, 844]]) {
    const size = `${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US', serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    const name = '  تقرير  ' + 'a'.repeat(180) + '.pdf  ';
    await page.goto(`${origin}/?details=full`, { waitUntil: 'networkidle' });
    const details = page.getByRole('group', { name: /^Details for تقرير/ });
    assert.equal(await details.getAttribute('data-details-id'), 'sample');
    assert.deepEqual(await details.locator('dt').allTextContents(), ['Name', 'Size', 'Kind', 'Modified', 'Uploaded', 'Shared with']);
    assert.deepEqual(await details.locator('dd').allTextContents(), [name, '5.4 GB · 5,368,709,120 bytes', 'PDF', '14 Nov 2026, 09:00 UTC', '12 Nov 2026, 09:00 UTC', 'Mora, Sam']);
    assert.equal(await details.locator('data').getAttribute('value'), '5368709120');
    const filename = details.locator('dd[dir="auto"]');
    assert.deepEqual(await filename.evaluate(el => {
      const { whiteSpace, unicodeBidi, textAlign } = getComputedStyle(el);
      const wrapsWithinCell = el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight;
      return { whiteSpace, unicodeBidi, textAlign, wrapsWithinCell };
    }), { whiteSpace: 'break-spaces', unicodeBidi: 'plaintext', textAlign: 'right', wrapsWithinCell: true });
    assert.equal(await details.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: resolve(output, `details-${size}.png`), fullPage: true });
    if (width === 320) {
      await context.close();
      continue;
    }
    await page.evaluate(axe);
    const results = await page.evaluate(() => window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
    }));
    await writeFile(resolve(output, `axe-details-${size}.json`), JSON.stringify(results, null, 2));
    assert.equal(results.violations.length, 0, `axe violations for details-${size}: ${JSON.stringify(results.violations)}`);

    const close = details.getByRole('button', { name: 'Hide details' });
    assert((await close.boundingBox())?.height >= 36, 'Hide details must meet the Drive minimum control height');
    await page.keyboard.press('Tab');
    const hasFocusRing = el => el === document.activeElement && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid';
    assert.equal(await close.evaluate(hasFocusRing), true);
    const greyscale = await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });
    await page.screenshot({ path: resolve(output, `details-${size}-greyscale.png`) });
    await greyscale.evaluate(el => el.remove());
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches && document.getAnimations().length === 0), true);
    assert.equal(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), true);
    assert.equal(await close.evaluate(hasFocusRing), true);
    await page.screenshot({ path: resolve(output, `details-${size}-forced-colours-focus.png`) });
    await page.emulateMedia({ reducedMotion: null, forcedColors: null });
    if (width === 390) await close.click();
    else await page.keyboard.press('Enter');
    await details.waitFor({ state: 'detached' });

    await page.goto(`${origin}/?details=missing`, { waitUntil: 'networkidle' });
    const missing = page.getByRole('group', { name: 'Details for whitespace-only name', exact: true });
    assert.deepEqual(await missing.locator('dt').allTextContents(), ['Name', 'Size', 'Kind']);
    assert.deepEqual(await missing.locator('dd').allTextContents(), [' \t ', '—', 'Folder']);
    assert.equal(await missing.locator('data').count(), 0);
    await page.screenshot({ path: resolve(output, `details-missing-${size}.png`), fullPage: true });

    for (const [variant, filename, bytes, sizeText] of [['zero', 'Empty.txt', '0', '0 bytes'], ['one', 'Tiny.txt', '1', '1 byte']]) {
      await page.goto(`${origin}/?details=${variant}`, { waitUntil: 'networkidle' });
      const small = page.getByRole('group', { name: `Details for ${filename}`, exact: true });
      assert.deepEqual(await small.locator('dt').allTextContents(), ['Name', 'Size', 'Kind']);
      assert.deepEqual(await small.locator('dd').allTextContents(), [filename, sizeText, 'File']);
      assert.equal(await small.locator('data').getAttribute('value'), bytes);
      await page.screenshot({ path: resolve(output, `details-${variant}-${size}.png`), fullPage: true });
    }
    await context.close();
    console.log(`FileDetails facts, filenames, close and axe passed at ${size}`);
  }
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
    const nextFile = page.getByRole('button', { name: 'Next file' });
    const rowName = page.getByRole('button', { name: 'Sample file', exact: true });
    // Only the callback can reach these destinations during Tab navigation.
    for (const target of [rowName, nextFile]) await target.evaluate(el => { el.tabIndex = -1; });
    await page.keyboard.press('ArrowUp');
    assert.equal(await items.last().evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.body.dataset.tabModal), 'false');
    assert.equal(await nextFile.evaluate(el => el === document.activeElement), true);
    await trigger.click();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.body.dataset.tabModal), 'false');
    assert.equal(await rowName.evaluate(el => el === document.activeElement), true);
    await rowName.click({ button: 'right' });
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
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?menu=shared&native-tab`, { waitUntil: 'networkidle' });
    const trigger = page.getByRole('button', { name: 'Actions for Sample file' });
    const menu = page.getByRole('menu', { name: 'Actions for Sample file' });
    const rowName = page.getByRole('button', { name: 'Sample file', exact: true });
    for (const [tabKey, item, direction, target] of [
      ['Tab', 'Details', 'next', 'Next file'],
      ['Shift+Tab', 'Download', 'previous', 'Sample file']
    ]) {
      // Open with focus on the row name, so closing the layer cannot restore it to the trigger.
      await rowName.focus();
      await rowName.click({ button: 'right' });
      await menu.waitFor();
      if (direction === 'next') await page.keyboard.press('End');
      assert.equal(await menu.getByRole('menuitem', { name: item }).evaluate(el => el === document.activeElement), true);
      await page.keyboard.press(tabKey);
      await menu.waitFor({ state: 'hidden' });
      const { tabDirection, tabLayerOpen } = await page.evaluate(() => ({ ...document.body.dataset }));
      assert.equal(tabDirection, direction);
      assert.equal(tabLayerOpen, 'false');
      assert.equal(await page.getByRole('button', { name: target, exact: true }).evaluate(el => el === document.activeElement), true, `${tabKey} must follow native tab order at ${width}px`);
    }
    await page.goto(`${origin}/?menu=throw`, { waitUntil: 'networkidle' });
    await trigger.click();
    await menu.waitFor();
    await page.evaluate(() => {
      window.addEventListener('keydown', event => { document.body.dataset.tabPrevented = String(event.defaultPrevented); }, { once: true });
    });
    const [error] = await Promise.all([page.waitForEvent('pageerror'), page.keyboard.press('Tab')]);
    assert.match(error.message, /Fixture onTab error/);
    assert.equal(await page.evaluate(() => document.body.dataset.tabPrevented), 'true');
    assert.equal(await menu.count(), 0);
    console.log(`Row menu native Tab, Shift+Tab and callback-error handling passed at ${width}x${height}`);
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
    const nextFile = page.getByRole('button', { name: 'Next file' });
    // Locator waits avoid injecting Playwright's own main-world pointerdown listener.
    const closedTrigger = trigger.and(page.locator('[aria-expanded="false"]'));
    const cdp = await context.newCDPSession(page);
    const { result: { objectId } } = await cdp.send('Runtime.evaluate', { expression: 'window' });
    const listenerTypes = async () => {
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId });
      return listeners.map(listener => listener.type).filter(type => ['pointerdown', 'resize', 'scroll'].includes(type)).sort();
    };
    const openListeners = ['pointerdown', 'resize', 'scroll'];
    assert.deepEqual(await listenerTypes(), [], 'Closed menu must not register window listeners');
    await trigger.click();
    assert.deepEqual(await listenerTypes(), openListeners, 'Opening must register one listener per event');
    if (width === 1280) {
      await nextFile.click();
      await closedTrigger.waitFor();
      assert.deepEqual(await listenerTypes(), [], 'Outside pointer dismissal must remove all three listeners');
      await trigger.click();
    }
    await page.setViewportSize({ width: width === 390 ? 1280 : 390, height: 800 });
    await closedTrigger.waitFor();
    assert.equal(await page.locator('dialog:modal').count(), 0, 'Resize must release modal');
    assert.deepEqual(await listenerTypes(), [], 'Closing must remove all three listeners');
    await trigger.click();
    await page.locator(width === 390 ? 'dialog:popover-open' : 'dialog:modal').waitFor({ state: 'attached' });
    assert.deepEqual(await listenerTypes(), openListeners, 'Reopening must register exactly one listener per event');
    await page.evaluate(() => window.dispatchEvent(new Event('fixture-unmount-menu')));
    await trigger.waitFor({ state: 'detached' });
    assert.equal(await page.locator('dialog:modal').count(), 0, 'Unmount must release modal');
    assert.deepEqual(await listenerTypes(), [], 'Unmounting an open menu must remove all three listeners');
    await nextFile.focus();
    assert.equal(await nextFile.evaluate(el => el === document.activeElement), true);
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
  for (const listing of [false, true]) for (const width of [320, 390, 1280]) {
    const height = width === 1280 ? 800 : 844;
    const prefix = `${listing ? 'listing-action-' : ''}menu-modes-${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?${listing ? 'listing&actions' : `menu=file${width === 1280 ? '' : '&longName'}`}`, { waitUntil: 'networkidle' });
    const name = listing ? 'Résumé 2025.pdf' : width === 1280 ? 'Sample file' : 'a'.repeat(200);
    const trigger = page.getByRole('button', { name: `Actions for ${name}`, exact: true });
    const scan = async state => {
      const results = await page.evaluate(() => window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
      }));
      await writeFile(resolve(output, `axe-${prefix}-${state}.json`), JSON.stringify(results, null, 2));
      assert.equal(results.violations.length, 0, `axe violations for ${prefix} ${state}: ${JSON.stringify(results.violations)}`);
    };
    if (listing) {
      await page.evaluate(axe);
      await scan('closed');
      await page.screenshot({ path: resolve(output, `${prefix}-closed.png`), fullPage: true });
    }
    await trigger.click();
    const menu = page.getByRole('menu', { name: `Actions for ${name}` });
    if (listing) {
      await menu.waitFor({ timeout: 5000 });
      await scan('open');
    }
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
    const fontResponses = [];
    if (width === 1280) page.on('response', response => {
      if (response.request().resourceType() === 'font') fontResponses.push(response);
    });
    await page.goto(`${origin}/?listing`, { waitUntil: 'networkidle' });
    if (width === 1280) {
      const fonts = await assertListingFonts(page, fontResponses, origin);
      await writeFile(resolve(output, `${size}-fonts.json`), JSON.stringify(fonts, null, 2));
    }
    const container = width > 820 ? page.getByRole('table') : page.getByRole('list');
    assert.equal(await container.count(), 1);
    assert.equal(await container.getAttribute('aria-label') ?? await container.locator('caption').textContent(), 'Contents of My Drive, folders first, then files, each sorted by name, A to Z (binary order). Times in America/New_York.');
    if (width > 820) assert.equal(await container.getByRole('columnheader', { name: 'Name' }).getAttribute('aria-sort'), 'other');
    assert.equal(await container.getByRole('link').count(), 3);
    assert.equal(await container.getByRole('link', { name: 'Archive' }).getAttribute('href'), '#archive');
    assert.equal(await container.getByRole('link', { name: 'Résumé 2025.pdf' }).getAttribute('href'), '#resume');
    const longName = container.getByRole('link', { name: 'a-very-long-file-name-without-breaks-to-check-reflow.txt' });
    assert.equal(await longName.textContent(), 'a-very-long-file-name-without-breaks-to-check-reflow.txt');
    assert.equal(await longName.evaluate(el => getComputedStyle(el).textOverflow), 'clip');
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
      assert.equal((await row.locator('.details').textContent()).trim(), 'PDF · 5.4 MB · 13 Nov');
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
      const glyphColours = await container.locator('.name svg').first().evaluate(el => ({
        stroke: getComputedStyle(el).stroke,
        canvasText: getComputedStyle(document.body).color
      }));
      assert.equal(glyphColours.stroke, glyphColours.canvasText, `Forced-colours glyph stroke at ${size}`);
      const link = container.getByRole('link', { name: 'Archive' });
      await link.focus();
      assert.equal(await link.evaluate(el => el === document.activeElement), true);
      await page.screenshot({ path: resolve(output, `${size}-forced-colours-focus.png`) });
      await writeFile(resolve(output, `${size}-modes.json`), JSON.stringify({ motion, forcedColours: true, focused: 'Archive' }, null, 2));
    }
    await context.close();
  }
  for (const width of [1280, 390, 320]) for (const segmenter of [true, false]) {
    const height = width === 1280 ? 800 : 844;
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    if (!segmenter) await context.addInitScript(() => { Intl.Segmenter = undefined; });
    const page = await context.newPage();
    const fontRequests = observeFontRequests(page);
    await page.goto(`${origin}/?listing&unicode`, { waitUntil: 'networkidle' });
    const selector = width > 820 ? 'table.desktop' : 'ul.mobile';
    await assertFullFilenames(page, selector, { width, height, segmenter, mode: 'baseline', fontRequests });
    assert.equal(await page.locator(`${selector} a[data-item-id="rtl"]`).evaluate(el => getComputedStyle(el).direction), 'rtl');
    const alignment = await page.locator(`${selector} a[data-item-id="ascii-255"]`).evaluate(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const first = range.getClientRects()[0];
      const glyph = el.parentElement.querySelector('svg').getBoundingClientRect();
      const row = el.closest('li, tr');
      const cells = [...row.querySelectorAll(':scope > td:not(:first-child)')].map(cell => {
        const text = document.createRange();
        text.selectNodeContents(cell);
        return text.getClientRects()[0];
      });
      return {
        glyphDelta: Math.abs((glyph.top + glyph.bottom - first.top - first.bottom) / 2),
        cellDeltas: cells.map(rect => Math.abs((rect.top + rect.bottom - first.top - first.bottom) / 2)),
        lines: range.getClientRects().length,
        rowHeight: row.getBoundingClientRect().height,
        linkHeight: el.getBoundingClientRect().height
      };
    });
    assert(alignment.lines > 1 && alignment.rowHeight >= alignment.linkHeight, `Long name must expand its row: ${JSON.stringify(alignment)}`);
    assert(alignment.glyphDelta <= 6 && alignment.cellDeltas.every(delta => delta <= 8), `First-line alignment: ${JSON.stringify(alignment)}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    await page.screenshot({ path: resolve(output, `listing-unicode-${width}-${segmenter ? 'segmenter' : 'fallback'}.png`), fullPage: true });
    await page.evaluate(axe);
    const results = await page.evaluate(() => window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
    }));
    await writeFile(resolve(output, `axe-unicode-${width}-${segmenter ? 'segmenter' : 'fallback'}.json`), JSON.stringify(results, null, 2));
    assert.equal(results.violations.length, 0, `axe violations for unicode ${width}: ${JSON.stringify(results.violations)}`);
    if (segmenter) {
      for (const [mode, css] of [
        ['css-zoom-200', 'html { zoom: 2; }'],
        ['css-zoom-400', 'html { zoom: 4; }'],
        ['text-spacing', '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; }'],
        ['font-fallback', '* { font-family: sans-serif !important; }']
      ]) {
        const override = await page.addStyleTag({ content: css });
        await page.evaluate(() => document.fonts.ready);
        const layout = await page.evaluate(() => ({
          listingWidth: document.querySelector('.listing').getBoundingClientRect().width,
          table: getComputedStyle(document.querySelector('table.desktop')).display,
          list: getComputedStyle(document.querySelector('ul.mobile')).display,
        }));
        if (width === 1280) {
          const compact = mode.startsWith('css-zoom-');
          assert.equal(layout.table === 'none' && layout.list !== 'none', compact, `${mode}: unexpected listing layout ${JSON.stringify(layout)}`);
          if (!compact) assert(layout.table !== 'none' && layout.list === 'none', `${mode}: desktop table required ${JSON.stringify(layout)}`);
          if (compact) {
            const sortedPage = await context.newPage();
            try {
              await sortedPage.goto(`${origin}/?listing&paged`, { waitUntil: 'networkidle' });
              await sortedPage.addStyleTag({ content: css });
              const sortedLayout = await sortedPage.evaluate(() => ({
                listingWidth: document.querySelector('.listing').getBoundingClientRect().width,
                table: getComputedStyle(document.querySelector('table.desktop')).display,
                list: getComputedStyle(document.querySelector('ul.mobile')).display,
                sort: getComputedStyle(document.querySelector('.compact-sort')).display
              }));
              assert(sortedLayout.table === 'none' && sortedLayout.list !== 'none' && sortedLayout.sort !== 'none', `${mode}: compact sort missing ${JSON.stringify(sortedLayout)}`);
            } finally { await sortedPage.close(); }
          }
        }
        const displayedSelector = layout.table === 'none' ? 'ul.mobile' : 'table.desktop';
        await assertFullFilenames(page, displayedSelector, { width, height, segmenter, mode, fontRequests, layout });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${mode}: horizontal page overflow`);
        await page.screenshot({ path: resolve(output, `listing-unicode-${width}-${mode}.png`), fullPage: true });
        await override.evaluate(el => el.remove());
      }
    }
    await context.close();
  }
  // Chrome's tabs API changes page zoom, unlike CSS zoom or pinch scaling.
  const zoomTemp = await mkdtemp(resolve(tmpdir(), 'drive-page-zoom-'));
  try {
    const extension = resolve(zoomTemp, 'extension');
    await mkdir(extension);
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'Page zoom evidence', version: '1.0',
      permissions: ['tabs'], background: { service_worker: 'worker.js' }
    }));
    await writeFile(resolve(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
    for (const factor of [2, 4]) {
      const context = await chromium.launchPersistentContext(resolve(zoomTemp, `profile-${factor}`), {
        channel: 'chromium', headless: true, viewport: null,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1280,800']
      });
      try {
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await context.routeWebSocket('**/*', socket => socket.close());
        const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
        const page = await context.newPage();
        const fontRequests = observeFontRequests(page);
        await page.goto(`${origin}/?listing&unicode`, { waitUntil: 'networkidle' });
        const before = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }));
        const applied = await worker.evaluate(async ({ url, factor }) => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find(item => item.url === url);
          if (!tab) throw new Error('Fixture tab not found');
          await chrome.tabs.setZoom(tab.id, factor);
          return chrome.tabs.getZoom(tab.id);
        }, { url: `${origin}/?listing&unicode`, factor });
        await page.waitForFunction(({ width, factor }) => Math.abs(innerWidth * factor - width) <= factor * 2, { width: before.width, factor });
        await page.evaluate(() => document.fonts.ready);
        const after = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth }));
        assert(Math.abs(applied - factor) < 1e-6, `Page zoom factor: requested ${factor}, reported ${applied}`);
        assert(Math.abs(after.dpr / before.dpr - factor) < 0.01, `Page zoom DPR: ${JSON.stringify({ before, after })}`);
        assert(after.scrollWidth <= after.width, `Page zoom horizontal overflow: ${JSON.stringify(after)}`);
        await assertFullFilenames(page, after.width > 820 ? 'table.desktop' : 'ul.mobile', { width: after.width, height: 'measured on failure', segmenter: true, mode: `page-zoom-${factor * 100}`, fontRequests });
        await page.screenshot({ path: resolve(output, `listing-unicode-page-zoom-${factor * 100}.png`), fullPage: true });
        await writeFile(resolve(output, `listing-unicode-page-zoom-${factor * 100}.json`), JSON.stringify({ factor: applied, before, after }, null, 2));
      } finally {
        await context.close();
      }
    }
  } finally {
    await rm(zoomTemp, { recursive: true, force: true });
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
    await assertWhitespaceName(tab, '\t');
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
    assert.equal(await page.locator('button[aria-haspopup="menu"], th.actions').count(), 0);
    assert.equal(await spaces.evaluate(el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))), true);

    await page.goto(`${origin}/?listing&actions`, { waitUntil: 'networkidle' });
    assert.equal(await container.getByRole('button', { name: /^Actions for / }).count(), 3);
    assert.equal(await page.getByRole('columnheader', { name: 'Actions', exact: true }).count(), width > 820 ? 1 : 0);
    const trigger = container.getByRole('button', { name: 'Actions for Archive', exact: true });
    const focus = page.locator(':focus');
    for (const [key, row] of [['Tab', '3'], ['Shift+Tab', '1']]) {
      await trigger.press('ArrowDown');
      const details = page.getByRole('menuitem', { name: 'Details', exact: true });
      await details.and(focus).waitFor({ timeout: 5000 });
      assert.equal(await page.getByRole('menuitem').count(), 1);
      await page.keyboard.press(key);
      await container.locator(`a[data-item-id="${row}"]`).and(focus).waitFor({ timeout: 5000 });
      assert.equal(await page.getByRole('menu').count(), 0);
    }
    const archive = container.locator('tr, li').filter({ has: page.getByRole('link', { name: 'Archive', exact: true }) });
    if (width <= 820) {
      const name = await archive.getByRole('link').boundingBox();
      const button = await trigger.boundingBox();
      const metadata = await archive.locator('.details').boundingBox();
      assert.ok(button.x >= name.x + name.width && button.y < metadata.y + metadata.height);
    }
    const metadata = archive.locator(width > 820 ? 'td:nth-child(4)' : '.details');
    await archive.evaluate(row => {
      row.addEventListener('beforetoggle', event => {
        event.preventDefault();
        row.dataset.cancelledMenuOpen = String(event.defaultPrevented);
      }, { capture: true, once: true });
    });
    await metadata.click({ button: 'right' });
    await archive.and(page.locator('[data-cancelled-menu-open="true"]')).waitFor({ timeout: 5000 });
    await trigger.and(page.locator('[aria-expanded="false"]')).waitFor({ timeout: 5000 });
    assert.equal(await archive.locator('dialog').count(), 0);
    await metadata.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Details', exact: true }).and(focus).waitFor({ timeout: 5000 });
    console.log(`Listing actions at ${width}px: cancelled opening collapses and the next right-click reopens`);
    await archive.evaluate(el => {
      const probe = document.createElement('span');
      probe.style.color = getComputedStyle(el).getPropertyValue('--drive-color-bg-raised');
      document.body.append(probe);
      el.dataset.expectedOpenColor = getComputedStyle(probe).color;
      probe.remove();
    });
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-expected-open-color]');
      return getComputedStyle(row).backgroundColor === row.dataset.expectedOpenColor;
    }, null, { timeout: 5000 });
    await page.getByRole('menuitem', { name: 'Details', exact: true }).click();
    assert.equal(await page.locator('main > p').textContent(), '1: Details');
    await trigger.and(focus).waitFor({ timeout: 5000 });
    // Linux Chromium cannot generate a macOS Control-click; dispatch its pointer event shape.
    const dispatchContextMenu = pointerType => metadata.evaluate((el, pointerType) => el.dispatchEvent(
      new PointerEvent('contextmenu', { bubbles: true, cancelable: true, button: 0, ctrlKey: true, pointerType })
    ), pointerType);
    assert.equal(await dispatchContextMenu(''), true, 'Keyboard-style context menu must not be intercepted');
    assert.equal(await page.getByRole('menu').count(), 0);
    assert.equal(await dispatchContextMenu('mouse'), false, 'Pointer Control-click should open row actions');
    await page.getByRole('menuitem', { name: 'Details', exact: true }).and(focus).waitFor({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await trigger.and(focus).waitFor({ timeout: 5000 });
    const ownedTrigger = container.getByRole('button', { name: 'Actions for Résumé 2025.pdf', exact: true });
    for (const action of ['Download', 'Share', 'Rename', 'Move', 'Details', 'Delete']) {
      await ownedTrigger.press('ArrowDown');
      await page.getByRole('menuitem', { name: action, exact: true }).click();
      assert.equal(await page.locator('main > p').textContent(), `2: ${action}`);
      assert.equal(await page.getByRole('menu').count(), 0);
      assert.equal(await page.locator('[data-details-id]').count(), 0, 'Details belongs to the caller, not an inline panel');
    }
    console.log(`Listing actions at ${width}px: opt-in, native Tab order, and all six actions forwarded`);
    await context.close();
  }
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    await page.goto(`${origin}/?listing&paged`, { waitUntil: 'networkidle' });
    const setContainerWidth = async width => {
      await page.locator('main').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
      assert.equal(await page.evaluate(() => innerWidth), 1280, 'Container resize must not change viewport width');
    };
    const table = page.getByRole('table');
    const list = page.getByRole('list');
    const link = { name: 'File 003.txt', exact: true };
    const focus = page.locator(':focus');
    for (const [desktop, compact] of [
      [page.getByRole('button', { name: 'Name', exact: true }), page.getByRole('combobox', { name: 'Sort', exact: true })],
      [table.getByRole('link', link), list.getByRole('link', link)]
    ]) {
      await desktop.focus();
      await desktop.and(focus).waitFor({ timeout: 5000 });
      await setContainerWidth(740);
      await compact.and(focus).waitFor({ timeout: 5000 });
      await setContainerWidth(741);
      await desktop.and(focus).waitFor({ timeout: 5000 });
    }
    const paging = page.getByRole('button', { name: 'Show 200 more' });
    const afterLayout = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await paging.focus();
    for (const [width, layout] of [[740, list], [741, table]]) {
      await setContainerWidth(width);
      await layout.waitFor({ timeout: 5000 });
      await afterLayout();
      assert.equal(await paging.and(focus).count(), 1, 'Container resize must not steal focus from paging');
    }
    await setContainerWidth(740);
    const compactLink = list.getByRole('link', link);
    await compactLink.focus();
    await compactLink.and(focus).waitFor({ timeout: 5000 });
    const main = page.locator('main');
    await main.evaluate(el => { el.hidden = true; });
    await page.waitForFunction(() => document.activeElement === document.body, null, { timeout: 5000 });
    await afterLayout();
    await setContainerWidth(741);
    await main.evaluate(el => { el.hidden = false; });
    await table.waitFor({ timeout: 5000 });
    await afterLayout();
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'Reopening the listing must not restore stale focus');
    console.log('Listing container-only focus passed in both directions; no paging focus theft or stale focus restoration');

    await page.goto(`${origin}/?listing&actions`, { waitUntil: 'networkidle' });
    const menuTrigger = layout => layout.getByRole('button', { name: 'Actions for Résumé 2025.pdf', exact: true });
    const download = page.getByRole('menuitem', { name: 'Download', exact: true }).and(focus);
    const waitForMenuClose = () => page.waitForFunction(() => !document.querySelector('dialog:popover-open, dialog:modal, [aria-expanded="true"]'), null, { timeout: 5000 });
    for (const [from, to, source, destination] of [[1000, 500, table, list], [500, 1000, list, table]]) {
      for (const phase of ['settled', 'opening']) {
        await setContainerWidth(from);
        const trigger = menuTrigger(source);
        await trigger.focus();
        if (phase === 'opening') {
          await main.evaluate((el, width) => {
            delete el.dataset.resizedDuringOpening;
            const showPopover = HTMLDialogElement.prototype.showPopover;
            HTMLDialogElement.prototype.showPopover = function () {
              delete HTMLDialogElement.prototype.showPopover;
              const result = showPopover.call(this);
              // Change layout before RowActions resumes and assigns menu-item focus.
              el.style.width = `${width}px`;
              el.dataset.resizedDuringOpening = 'true';
              return result;
            };
          }, to);
        }
        await page.keyboard.press('ArrowDown');
        if (phase === 'settled') {
          await download.waitFor({ timeout: 5000 });
          await setContainerWidth(to);
        } else {
          await main.and(page.locator('[data-resized-during-opening="true"]')).waitFor({ timeout: 5000 });
        }
        await menuTrigger(destination).and(focus).waitFor({ timeout: 5000 });
        await waitForMenuClose();
        assert.equal(await page.evaluate(() => innerWidth), 1280);
        console.log(`Listing action menu: ${phase} ${from}→${to} closed and moved focus to the same row`);
      }
      // Render the destination, then open and blur in a transient source layout
      // before the next frame. ResizeObserver can coalesce the two width changes.
      for (const duringBlur of [false, true]) {
        await afterLayout();
        await main.evaluate(async (el, { from, to, duringBlur }) => {
          el.style.width = `${from}px`;
          const selector = from > 740 ? 'table.desktop' : 'ul.mobile';
          const trigger = el.querySelector(`${selector} button[aria-label="Actions for Résumé 2025.pdf"]`);
          trigger.focus();
          const item = await new Promise((resolve, reject) => {
            const controller = new AbortController();
            const timer = setTimeout(() => { controller.abort(); reject(new Error('Menu item never focused')); }, 5000);
            el.addEventListener('focusin', event => {
              if (!event.target.matches('[role="menuitem"]')) return;
              clearTimeout(timer);
              controller.abort();
              resolve(event.target);
            }, { signal: controller.signal });
            trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
          });
          const resize = () => { el.style.width = `${to}px`; };
          if (duringBlur) item.addEventListener('blur', resize, { once: true });
          item.blur();
          if (document.activeElement !== document.body) throw new Error('Menu item did not blur to the body');
          if (!duringBlur) resize();
        }, { from, to, duringBlur });
        await waitForMenuClose();
        await afterLayout();
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'Resize must not restore explicitly blurred focus');
        console.log(`Listing action menu: ${from}→${to} resize ${duringBlur ? 'inside' : 'after'} blur leaves focus on the body`);
      }

      await setContainerWidth(from);
      await afterLayout();
      const trigger = menuTrigger(source);
      for (const interruption of ['before layer', 'after layer', 'after layer with microtask restoration']) {
        await trigger.evaluate(async (button, { from, to, interruption }) => {
          const container = button.closest('main');
          const hideTrigger = () => { container.style.width = `${to}px`; };
          const restoreTrigger = () => { container.style.width = `${from}px`; };
          const afterShow = interruption !== 'before layer';
          const microtaskRestore = interruption === 'after layer with microtask restoration';
          const showPopover = HTMLDialogElement.prototype.showPopover;
          let shown = false;
          if (afterShow) HTMLDialogElement.prototype.showPopover = function () {
            showPopover.call(this);
            shown = this.matches(':popover-open');
            hideTrigger();
            if (microtaskRestore) queueMicrotask(restoreTrigger);
          };
          button.focus();
          // Register before the listing's opening frame; the microtask variant
          // restores sooner, before the positioning update has flushed.
          const restored = new Promise(resolve => requestAnimationFrame(() => {
            if (!microtaskRestore) restoreTrigger();
            resolve();
          }));
          try {
            button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            if (!afterShow) hideTrigger();
            await restored;
            if (afterShow && !shown) throw new Error('Expected an open layer before the resize');
          } finally {
            if (afterShow) delete HTMLDialogElement.prototype.showPopover;
          }
        }, { from, to, interruption });
        await waitForMenuClose();
        if (interruption !== 'before layer') await trigger.and(focus).waitFor({ timeout: 5000 });
        await trigger.press('ArrowDown');
        await download.waitFor({ timeout: 5000 });
        await page.keyboard.press('Escape');
        await waitForMenuClose();
        console.log(`Listing action menu: aborted ${from}→${to}→${from} opening (${interruption}) can reopen`);
      }
    }
    await main.evaluate(el => el.style.removeProperty('width'));
    for (const [width, source, destination, layer] of [[390, table, list, ':popover-open'], [1280, list, table, ':modal']]) {
      await menuTrigger(source).press('ArrowDown');
      await download.waitFor({ timeout: 5000 });
      assert.equal(await page.locator(`dialog${layer}`).count(), 1);
      await page.setViewportSize({ width, height: 800 });
      await menuTrigger(destination).and(focus).waitFor({ timeout: 5000 });
      await waitForMenuClose();
    }
    console.log('Listing action menus preserve deliberate blur and hand off focus between viewport layouts, including the modal sheet');
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
  for (const name of ['head.txt', 'details-1280x800.png', 'details-390x844.png', ...[1280, 390].flatMap(width => [`listing-footer-default-${width}.png`, `listing-footer-error-${width}.png`]), ...states.flatMap(state => [1280, 390].flatMap((width, i) => {
    const size = `${state}-${width}x${[800, 844][i]}`;
    return [`${size}.png`, `axe-${size}.json`, `keyboard-${size}.json`];
  }))]) assert((await stat(resolve(output, name))).size > 0, `Missing evidence: ${name}`);
} finally {
  await browser?.close();
  await server.close();
}
