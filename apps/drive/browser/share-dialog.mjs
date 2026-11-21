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
      const page = await context.newPage(), dialog = page.getByRole('dialog');
      page.on('pageerror', error => blocked.push(error.message));
      const opener = page.getByRole('button', { name: 'Open Share' });
      const input = dialog.getByRole('combobox', { name: 'Add people' });
      const button = name => dialog.getByRole('button', { name, exact: true });
      const text = value => dialog.getByText(value, { exact: true });
      const key = name => page.keyboard.press(name);
      const writes = async (...ids) => assert.deepEqual(JSON.parse(await page.getByRole('main', { includeHidden: true }).getAttribute('data-writes')), ids);
      const open = async mode => { await page.goto(`${origin}/?share-dialog=${mode}`); await opener.press('Enter'); await dialog.waitFor(); };
      const settle = () => page.evaluate(() => window.dispatchEvent(new Event('fixture-settle')));
      await open(width === 1280 ? 'actions' : 'file');
      assert.equal(await dialog.getByText(/anything you add/).count(), width === 1280 ? 1 : 0);
      assert(await input.evaluate(el => el === document.activeElement));
      assert.equal(await dialog.getByRole('option').count(), 1, 'Existing access and owner excluded from choices');
      await key('Escape');
      assert(await dialog.isVisible(), 'First Escape closes the picker, not the dialog');
      assert.equal(await dialog.getByRole('listbox').count(), 0);
      await page.evaluate(() => window.fixtureFonts);
      assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), 'Dialog must reflow without horizontal scrolling');
      const prefix = `share-dialog-${width}x${height}`;
      await page.screenshot({ path: resolve(output, `${prefix}.png`) });
      await page.evaluate(axe);
      const audit = await page.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
      await writeFile(resolve(output, `axe-${prefix}.json`), JSON.stringify(audit, null, 2));
      assert.equal(audit.violations.length, 0, JSON.stringify(audit.violations));
      const tree = await dialog.ariaSnapshot();
      assert(!tree.includes('opaque-'), 'Opaque IDs must not be presented');
      assert.match(tree, /You · owner[\s\S]*Through Projects/);
      await button('Done').focus(); await key('Tab');
      assert(await button('Close').evaluate(el => el.matches(':focus-visible')));
      await key('Shift+Tab');
      assert(await button('Done').evaluate(el => el === document.activeElement));
      if (width === 1280) {
        await input.focus(); await key('ArrowDown'); await key('Enter');
        await button('Next page of people to add').click();
        await dialog.getByRole('list', { name: 'Selected people' }).getByText('Lee Ray').waitFor();
        await input.fill('not on this page'); await text('No matching people available on this page.').waitFor();
        await input.fill(''); await key('ArrowDown'); await key('Enter');
        await button('Share with 2 people').click(); await button('Sharing…').waitFor();
        await key('Escape'); assert(await dialog.isVisible());
        await settle(); await dialog.getByRole('alert').waitFor();
        assert(await dialog.getByRole('alert').evaluate(el => el === document.activeElement));
        await writes('opaque-4', 'opaque-5');
        await button('Share with 2 people').click(); await settle(); await text('Shared with 2 people').waitFor();
        await dialog.getByText('Name unavailable', { exact: true }).waitFor();
        await button('Remove Sam Mora’s direct access').click(); await button('Cancel').click(); await writes('opaque-4', 'opaque-5', 'opaque-4', 'opaque-5');
        await button('Remove Sam Mora’s direct access').click();
        await button('Confirm removal of direct access for Sam Mora').click();
        await button('Removing direct access for Sam Mora').waitFor();
        await key('Escape'); assert(await dialog.isVisible());
        await settle(); await dialog.getByText(/Couldn’t confirm removal/).waitFor();
        await button('Confirm removal of direct access for Sam Mora').click(); await settle();
        await text('Removed direct access for Sam Mora. Access through Projects remains.').waitFor();
        assert.equal(await dialog.getByRole('listitem').filter({ hasText: 'Sam Mora' }).getByRole('button').count(), 0);
        await button('Remove Pell Quinn’s access').click();
        await button('Confirm removal of direct access for Pell Quinn').click(); await settle();
        await dialog.getByRole('listitem').filter({ hasText: 'Pell Quinn' }).waitFor({ state: 'hidden' });
        await writes('opaque-4', 'opaque-5', 'opaque-4', 'opaque-5', 'opaque-2', 'opaque-2', 'opaque-1');
      }
      await key('Escape'); await dialog.waitFor({ state: 'hidden' });
      assert(await opener.evaluate(el => el === document.activeElement));
      for (const mode of ['owner', 'member', 'failed', 'partial']) {
        await open(mode);
        if (mode === 'owner' || mode === 'member') {
          await text('Only you can see this.').waitFor();
          if (mode === 'owner') { await button('Invite someone').click(); await page.getByText('Users and invites').waitFor(); }
          else await text('Ask the owner to invite them.').waitFor();
        } else {
          assert.equal(await text('Only you can see this.').count(), 0);
          if (mode === 'failed') { await text('Couldn’t load people with access.').waitFor(); await button('Retry loading people with access').click(); await text('Only you can see this.').waitFor(); }
          else { await button('Next page of people with access').click(); await text('Loading people with access…').waitFor(); }
          await writes();
        }
      }
      assert.deepEqual(blocked, []);
      await writeFile(resolve(output, `${prefix}-keyboard.txt`), `Verified initial focus, Escape order, Tab and Shift+Tab wrap, and opener focus return. Chromium accessibility tree; not a spoken screen-reader test.\n${tree}\n`);
      console.log(`K7/K13 Share dialog, keyboard and axe passed at ${width}×${height}`);
    } finally { await context.close(); }
  }
}
