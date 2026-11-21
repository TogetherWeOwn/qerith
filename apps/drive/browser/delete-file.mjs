import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const path = number => `/api/entries/00000000-0000-4000-8000-00000000000${number}/delete`;
const body = '{"confirm":"permanent-delete"}';
const warning = "This deletes the file for good. There's no bin, so it can't be restored.";
const uncertain = 'We couldn’t confirm the deletion request. Check My Drive before trying again.';

export async function exerciseDeleteFile(browser, origin, axe, output) {
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const writes = [], blocked = [], errors = [];
    let reply = 0, held;
    try {
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin && !url.pathname.startsWith('/api/') && request.method() === 'GET') return route.continue();
        if (url.origin !== origin || ![1, 2, 3].some(number => path(number) === url.pathname) || url.search) {
          blocked.push([request.method(), url.pathname]);
          return route.abort();
        }
        const status = reply;
        writes.push([request.method(), url.pathname, request.headers()['content-type'], request.postData(), status]);
        if (held) await held.promise;
        return status ? route.fulfill({ status }) : route.abort();
      });
      await context.routeWebSocket('**/*', socket => socket.close());
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/?delete-file`);
      await page.evaluate(axe);
      const dialog = page.getByRole('dialog', { name: /^Delete / });
      const focused = page.locator(':focus');
      const button = label => dialog.getByRole('button', { name: label, exact: true });
      const trigger = name => page.getByRole('button', { name: `Delete ${name}`, exact: true });
      const open = async name => {
        await trigger(name).press('Enter');
        await dialog.getByRole('heading', { name: `Delete “${name}”?` }).waitFor();
        await button('Cancel').and(focused).waitFor();
        assert.equal(await dialog.getByText(warning, { exact: true }).count(), 1);
      };
      const captures = {};
      const capture = async stage => {
        const stem = `delete-file-${width}-${stage}`;
        const result = await page.evaluate(() => window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        }));
        await writeFile(resolve(output, `axe-${stem}.json`), JSON.stringify(result, null, 2));
        assert.equal(result.violations.length, 0, `${stem}: ${JSON.stringify(result.violations)}`);
        await page.screenshot({ path: resolve(output, `${stem}.png`) });
        captures[stage] = { focus: (await focused.innerText()).trim(), tree: await (stage === 'accepted' ? page.getByRole('main') : dialog).ariaSnapshot() };
      };
      const first = 'Receipts.pdf', next = 'Statement.pdf', last = `${'税'.repeat(80)}.pdf`;
      const backdrop = () => page.mouse.click(4, 4);
      for (const close of [() => page.keyboard.press('Enter'), () => page.keyboard.press('Escape'), () => button('Close').click(), backdrop]) {
        await open(first);
        await close();
        await dialog.waitFor({ state: 'hidden' });
        await trigger(first).and(focused).waitFor();
      }
      assert.equal(writes.length, 0, 'dismissals never send a request');
      await open(first);
      for (const [key, label] of [['Tab', 'Close'], ['Shift+Tab', 'Cancel'], ['Shift+Tab', 'Delete permanently'], ['Shift+Tab', 'Close']]) {
        await page.keyboard.press(key);
        await button(label).and(focused).waitFor();
      }
      await page.keyboard.press('Shift+Tab');
      await button('Cancel').and(focused).waitFor();
      const box = await dialog.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0);
      if (width < 820) assert(Math.abs(box.y + box.height - height) < 1 && box.width === width, 'mobile bottom sheet');
      else assert(box.y > 4 && box.y + box.height < height, 'desktop modal');
      await capture('open');
      assert.equal(await dialog.evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'reduced motion');
      const grayscale = await page.addStyleTag({ content: 'main, dialog, dialog::backdrop { filter: grayscale(1); }' });
      await page.screenshot({ path: resolve(output, `delete-file-${width}-greyscale.png`) });
      await grayscale.evaluate(el => el.remove());
      await page.emulateMedia({ forcedColors: 'active' });
      assert(await button('Cancel').and(focused).evaluate(el => {
        const style = getComputedStyle(el);
        return style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) > 0 && parseFloat(style.borderWidth) > 0;
      }), 'forced colours preserve the button border and focus ring');
      await page.screenshot({ path: resolve(output, `delete-file-${width}-forced-colours.png`) });
      await page.emulateMedia({ forcedColors: null });

      const expectedErrors = [[400, 'The deletion request was rejected.'], [401, 'Sign in again before deleting this file.'],
        [403, 'That file isn’t available to delete. Refresh My Drive.'], [404, 'That file isn’t available to delete. Refresh My Drive.'],
        [200, uncertain], [0, uncertain], [503, uncertain]];
      for (const [status, text] of expectedErrors) {
        reply = status;
        await button('Delete permanently').press('Enter');
        await dialog.getByRole('alert').filter({ hasText: text }).and(focused).waitFor();
        assert.equal(await page.locator('main li').count(), 3, 'retain the row without acceptance');
        assert.equal(await page.locator('main [role=status]').innerText(), '');
      }
      await capture('error');
      assert.equal(writes.length, expectedErrors.length, 'no implicit retries');

      reply = 202;
      held = Promise.withResolvers();
      try {
        await button('Delete permanently').press('Enter');
        const saving = button('Deleting…');
        assert.equal(await saving.getAttribute('aria-busy'), 'true');
        await saving.and(focused).waitFor();
        await capture('saving');
        for (const label of ['Close', 'Cancel', 'Deleting…']) {
          assert.equal(await button(label).getAttribute('aria-disabled'), 'true');
          await button(label).press('Enter');
        }
        await page.keyboard.press('Escape');
        await backdrop();
        assert(await dialog.isVisible());
        assert.equal(await page.locator('main li').count(), 3);
        assert.equal(writes.length, expectedErrors.length + 1, 'a pending request cannot be repeated');
      } finally { held.resolve(); held = undefined; }

      const accept = async (name, focus) => {
        await dialog.waitFor({ state: 'hidden' });
        await page.getByRole('status').filter({ hasText: `Deletion request accepted for “${name}”.` }).waitFor();
        assert.equal(await trigger(name).count(), 0);
        await focus.and(focused).waitFor();
      };
      await accept(first, page.getByText(next, { exact: true }));
      await capture('accepted');
      await open(last);
      if (width === 390) await page.setViewportSize({ width: 320, height });
      assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth && document.documentElement.scrollWidth <= innerWidth),
        'long filename wraps without horizontal scrolling');
      if (width === 390) {
        await page.screenshot({ path: resolve(output, 'delete-file-320-reflow.png') });
        await page.setViewportSize({ width, height });
      }
      await button('Delete permanently').press('Enter');
      await accept(last, page.getByText(next, { exact: true }));
      await open(next);
      await button('Delete permanently').press('Enter');
      await accept(next, page.getByRole('heading', { name: 'My Drive' }));
      assert.equal(await page.locator('main li').count(), 0);
      assert.deepEqual(writes, [...expectedErrors.map(([status]) => [1, status]), [1, 202], [3, 202], [2, 202]]
        .map(([number, status]) => ['POST', path(number), 'application/json', body, status]));
      assert.deepEqual(blocked, []);
      assert.deepEqual(errors, []);
      await writeFile(resolve(output, `delete-file-${width}-keyboard.json`), JSON.stringify({ width, height, writes, captures }, null, 2));
      console.log(`Owned-file permanent deletion fixture, keyboard, and axe passed at ${width}x${height}`);
    } finally { await context.close(); }
  }
}
