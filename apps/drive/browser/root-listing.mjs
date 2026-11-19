import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const widths = [[390, 844], [1280, 800]];
const axe = await readFile(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const output = process.env.DRIVE_BROWSER_EVIDENCE_DIR;
const file = 'Résumé 2026.pdf';
const id = '00000000-0000-4000-8000-000000000002';
const href = `/api/download/${id}`;

async function capture(page, state, width, audit = true) {
  const label = `root-${state}-${width}`;
  await page.screenshot({ path: resolve(output, `${label}.png`), fullPage: true });
  if (!audit) return;
  await page.evaluate(axe);
  const result = await page.evaluate(() => window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'] },
  }));
  await writeFile(resolve(output, `axe-${label}.json`), JSON.stringify(result, null, 2));
  assert.deepEqual(result.violations.map(({ id }) => id), [], label);
}

export async function captureSignedOut(page) {
  await page.getByRole('button', { name: 'Sign in with a passkey' }).waitFor();
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await capture(page, 'signed-out', width);
  }
}

export async function captureRootListing(page, origin, db) {
  const root = suffix => page.goto(`${origin}/${suffix}`);
  const empty = page.getByText('Your drive is empty.', { exact: true });
  const download = page.getByRole('link', { name: file, exact: true });
  await root('');
  await empty.waitFor();
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await capture(page, 'empty', width);
  }
  await db.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes)
    VALUES (?, 'fixture-owner', ?, 'file', 'internal-root-fixture-key', 1)`).bind(id, file).run();
  for (const [width, height] of [...widths, [320, 844]]) {
    await page.setViewportSize({ width, height });
    await root('');
    await page.getByRole('heading', { name: 'My Drive', exact: true }).waitFor();
    await download.waitFor();
    assert.equal(await download.count(), 1, 'exactly one file link is visible');
    assert.equal(await download.getAttribute('href'), href);
    assert.equal(await page.getByRole(width === 1280 ? 'table' : 'list').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.doesNotMatch(await page.content(), /internal-root-fixture-key/);
    await capture(page, 'listed', width, width !== 320);
    if (width === 320) continue;
    await page.keyboard.press('Tab');
    const focus = await download.evaluate(el => ({ focused: document.activeElement === el, outline: getComputedStyle(el).outlineStyle }));
    assert.deepEqual(focus, { focused: true, outline: 'solid' });
    await writeFile(resolve(output, `root-keyboard-${width}.json`), JSON.stringify(focus));
    await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });
    await capture(page, 'greyscale', width, false);
    await root('');
    await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
    await page.keyboard.press('Tab');
    assert.equal(await download.evaluate(el => document.activeElement === el && getComputedStyle(el).outlineStyle === 'solid'), true);
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    await capture(page, 'forced-colours-focus', width, false);
    await page.emulateMedia({ reducedMotion: null, forcedColors: null });
  }
  // No storage is configured in the read-only fixture; the link reaches the reviewed route and fails closed.
  assert.equal(await page.evaluate(async href => (await fetch(href)).status, href), 503);
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await root('?page=invalid');
    await page.getByRole('link', { name: 'Back to first page' }).waitFor();
    await capture(page, 'invalid-page', width);
  }
  console.log('Generated My Drive route: signed-out, empty, listed, recovery, axe, keyboard and responsive evidence captured');
}
