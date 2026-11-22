import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { accessibilityFiles, viewports } from '../../../scripts/browser-registry.mjs';

export async function captureAxe(page, axe, output, name) {
  await page.evaluate(axe);
  const result = await page.evaluate(() => window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'] },
  }));
  await writeFile(resolve(output, name), JSON.stringify(result, null, 2));
  assert.deepEqual(result.violations.map(({ id }) => id), [], name);
}

export async function captureReviewModes(page, { output, files, fullPage = false, greyscale, assertReflow, focusForced }) {
  const viewport = page.viewportSize();
  const screenshot = (file, options) => page.screenshot({ path: resolve(output, file), ...options });
  await screenshot(files.greyscale, { style: greyscale });
  try {
    await page.setViewportSize({ ...viewport, width: 320 });
    await assertReflow();
    await screenshot(files.reflow, { fullPage });
  } finally {
    await page.setViewportSize(viewport);
  }
  await page.emulateMedia({ forcedColors: 'active' });
  try {
    await focusForced();
    await screenshot(files['forced-colours'], { fullPage });
  } finally {
    await page.emulateMedia({ forcedColors: null });
  }
}

// Pass the exercise's keyboard assertions as a callback while this state is visible.
export async function captureAccessibility(page, { id, state, width, axe, output, keyboard, focusForced }) {
  assert.deepEqual(page.viewportSize(), { width, height: viewports[width] });
  const files = accessibilityFiles(id, state, width);
  const focus = await keyboard();
  assert(typeof focus === 'string' && focus.trim(), 'Keyboard capture requires a focused control');
  const tree = await page.locator('body').ariaSnapshot();
  await writeFile(resolve(output, files.keyboard), JSON.stringify({ focus, tree }, null, 2));
  await page.screenshot({ path: resolve(output, files.screenshot) });
  await captureAxe(page, axe, output, files.axe);
  await captureReviewModes(page, {
    files, output, focusForced, greyscale: 'html { filter: grayscale(1); }',
    assertReflow: async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)),
  });
}
