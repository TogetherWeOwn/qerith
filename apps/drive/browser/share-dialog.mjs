import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function exerciseShareDialog(browser, origin, axe, output) {
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const blocked = [];
    try {
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === origin && request.method() === 'GET' && !url.pathname.startsWith('/api/')) return route.continue();
        blocked.push(request.method()); return route.abort();
      });
      await context.routeWebSocket('**/*', socket => socket.close());
      const page = await context.newPage(), { keyboard } = page, dialog = page.getByRole('dialog');
      page.on('pageerror', error => blocked.push(error.message));
      const opener = page.getByRole('button', { name: 'Open Share' });
      const input = dialog.getByRole('combobox', { name: 'Add people' });
      const button = name => dialog.getByRole('button', { name, exact: true });
      const text = value => dialog.getByText(value, { exact: true });
      const focused = locator => locator.and(page.locator(':focus')).waitFor({ timeout: 3000 });
      const writes = async (...ids) => assert.deepEqual(JSON.parse(await page.getByRole('main', { includeHidden: true }).getAttribute('data-writes')), ids);
      const open = async mode => {
        await page.goto(`${origin}/?share-dialog=${mode}`); await opener.press('Enter'); await dialog.waitFor();
        assert.equal(await page.locator('[role="status"], [aria-live="polite"]').count(), 1);
      };
      const settle = () => page.evaluate(() => window.dispatchEvent(new Event('fixture-settle')));
      await open(width === 1280 ? 'actions' : 'file');
      assert.equal(await dialog.getByText(/anything you add/).count(), width === 1280 ? 1 : 0);
      assert(await input.evaluate(el => el === document.activeElement));
      assert.equal(await dialog.getByRole('option').count(), 1, 'Existing access and owner excluded from choices');
      await keyboard.press('Escape');
      assert(await dialog.isVisible() && !await dialog.getByRole('listbox').count(), 'First Escape closes only the picker');
      await page.evaluate(() => window.fixtureFonts);
      const prefix = `share-dialog-${width}x${height}`;
      const screenshot = (suffix = '', style) => page.screenshot({ path: resolve(output, `${prefix}${suffix}.png`), style });
      await screenshot(); await screenshot('-greyscale', 'dialog { filter: grayscale(1); }');
      await page.setViewportSize({ width: 320, height });
      assert(await dialog.evaluate(el => [el, document.documentElement].every(box => box.scrollWidth <= box.clientWidth)), 'No horizontal scroll at 320 CSS px');
      await screenshot('-reflow-320'); await page.setViewportSize({ width, height });
      await page.evaluate(axe);
      const audit = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
      await writeFile(resolve(output, `axe-${prefix}.json`), JSON.stringify(audit, null, 2));
      assert.equal(audit.violations.length, 0, JSON.stringify(audit.violations));
      const tree = await dialog.ariaSnapshot();
      assert(!tree.includes('opaque-') && /You · owner[\s\S]*Through Projects/.test(tree), 'Access tree shows provenance, not opaque IDs');
      await button('Done').focus(); await keyboard.press('Tab');
      await page.emulateMedia({ forcedColors: 'active' });
      assert(await button('Close').evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid'));
      await screenshot('-forced-colours'); await page.emulateMedia({ forcedColors: 'none' });
      await keyboard.press('Shift+Tab');
      assert(await button('Done').evaluate(el => el === document.activeElement));
      const announced = value => dialog.getByRole('status').filter({ hasText: value }).waitFor({ state: 'attached' });
      await input.focus(); await keyboard.press('ArrowDown'); await keyboard.press('Enter'); await announced('Lee Ray selected. 1 selected.');
      await button('Next page of people to add').click(); await announced('Showing page 2 of people to add.');
      await dialog.getByRole('list', { name: 'Selected people' }).getByText('Lee Ray').waitFor();
      await input.fill('not on this page'); await announced('No matching people available on this page.');
      await input.fill(''); await keyboard.press('ArrowDown'); await keyboard.press('Enter');
      await button('Share with 2 people').click(); await button('Sharing…').waitFor();
      await keyboard.press('Escape'); assert(await dialog.isVisible());
      await settle(); await dialog.getByRole('alert').waitFor();
      assert(await dialog.getByRole('alert').evaluate(el => el === document.activeElement));
      await writes('opaque-4', 'opaque-5');
      await button('Share with 2 people').click(); await button('Remove Lee Ray').focus(); await settle();
      await announced('Shared with 2 people'); await focused(button('Done')); await text('Name unavailable').waitFor();
      const removeSam = button('Remove Sam Mora’s direct access'), confirmSam = button('Confirm removal of direct access for Sam Mora');
      await removeSam.click(); await button('Cancel').click(); await writes('opaque-4', 'opaque-5', 'opaque-4', 'opaque-5');
      await removeSam.click(); await confirmSam.click(); await button('Removing direct access for Sam Mora').waitFor();
      assert.equal(await dialog.getByRole('status').filter({ hasText: /\d+ selected\./ }).count(), 0, 'Removal must not re-announce the cleared selection');
      await keyboard.press('Escape'); assert(await dialog.isVisible());
      await settle(); await dialog.getByText(/Couldn’t confirm removal/).waitFor();
      await confirmSam.click(); await button('Done').focus(); await settle();
      await announced('Removed direct access for Sam Mora. Access through Projects remains.'); await focused(button('Done'));
      assert.equal(await dialog.getByRole('listitem').filter({ hasText: 'Sam Mora' }).getByRole('button').count(), 0);
      await button('Remove Pell Quinn’s access').click();
      await button('Confirm removal of direct access for Pell Quinn').click(); await settle();
      await dialog.getByRole('listitem').filter({ hasText: 'Pell Quinn' }).waitFor({ state: 'hidden' });
      await focused(dialog.getByRole('heading', { name: 'People with access' }));
      await writes('opaque-4', 'opaque-5', 'opaque-4', 'opaque-5', 'opaque-2', 'opaque-2', 'opaque-1');
      await input.fill('not on this page'); await button('Done').click(); await dialog.waitFor({ state: 'hidden' });
      await opener.press('Enter');
      assert.equal(await input.inputValue(), '', 'A new Share session resets the previous search');
      await keyboard.press('Escape'); await keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      assert(await opener.evaluate(el => el === document.activeElement));
      for (const mode of ['owner', 'member', 'failed', 'partial']) {
        await open(mode);
        if (mode === 'owner' || mode === 'member') {
          await text('Only you can see this.').waitFor();
          if (mode === 'owner') { await button('Invite someone').click(); await page.getByText('Users and invites').waitFor(); }
          else await text('Ask the owner to invite them.').waitFor();
        } else {
          assert.equal(await text('Only you can see this.').count(), 0);
          if (mode === 'failed') {
            await text('Couldn’t load people with access.').waitFor(); await button('Retry loading people with access').click();
            await announced('Loaded people with access.'); await focused(dialog.getByRole('heading', { name: 'People with access' }));
            for (const name of ['Pell Quinn', 'Sam Mora', 'Zoë Chen']) await dialog.getByRole('listitem').filter({ hasText: name }).waitFor();
          } else {
            await dialog.getByRole('option', { name: 'Lee Ray', exact: true }).waitFor();
            await button('Next page of people to add').click({ timeout: 3000 }); await announced('Showing page 2 of people to add.');
            await input.focus(); await dialog.getByRole('option', { name: 'Name unavailable', exact: true }).waitFor();
            assert.equal(await button('Next page of people to add').count(), 0, 'No pages offer Sam or the owner');
            await keyboard.press('Escape'); await button('Next page of people with access').click(); await announced('Loading people with access…');
            await input.focus(); await keyboard.press('ArrowDown'); await keyboard.press('Enter'); await announced('Name unavailable selected. 1 selected.');
            await settle(); await announced('Showing page 2 of people with access.'); await button('Remove Pell Quinn’s access').waitFor();
            await input.fill('not on this page'); await button('Remove Name unavailable').click(); await announced('Name unavailable removed. 0 selected.');
            await input.click(); await announced('No matching people available on this page.'); await keyboard.press('Escape'); assert.equal(await dialog.getByRole('status').textContent(), '');
          }
          assert.equal(await text('Only you can see this.').count(), 0);
          await writes();
        }
      }
      assert.deepEqual(blocked, []);
      await writeFile(resolve(output, `${prefix}-keyboard.txt`), `Verified initial focus, Escape order, Tab and Shift+Tab wrap, and opener focus return. Chromium accessibility tree; not a spoken screen-reader test.\n${tree}\n`);
      console.log(`K7/K13 Share dialog, keyboard and axe passed at ${width}×${height}`);
    } finally { await context.close(); }
  }
}
