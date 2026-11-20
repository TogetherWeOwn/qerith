import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function exerciseOwnerInvite(browser, origin, axe, output) {
  for (const [width, height] of [[1280, 800], [390, 844], [320, 844]]) {
    const size = `${width}x${height}`;
    const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'UTC', serviceWorkers: 'block' });
    const unexpected = [];
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin && request.method() === 'GET' && !url.pathname.startsWith('/api/') && url.pathname !== '/invite') return route.continue();
      unexpected.push(request.method());
      return route.abort();
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    try {
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date('2026-11-14T18:00:00Z'));
      const fixture = `${origin}/?owner-invite`;
      await page.goto(fixture);
      const open = page.getByRole('button', { name: 'Invite someone', exact: true });
      const dialog = page.getByRole('dialog', { name: 'Invite someone' });
      const name = dialog.getByRole('textbox', { name: 'Name (optional)', exact: true });
      const note = dialog.getByRole('textbox', { name: "Note for them (optional, they'll see it)", exact: true });
      const make = dialog.getByRole('button', { name: 'Make invite link' });
      const cancel = dialog.getByRole('button', { name: 'Cancel' });
      const close = dialog.getByRole('button', { name: 'Close' });
      const done = dialog.getByRole('button', { name: 'Done' });
      const copy = dialog.getByRole('button', { name: 'Copy link' });
      const focus = locator => locator.and(page.locator(':focus')).waitFor({ timeout: 5000 });
      const tab = async (locator, key = 'Tab') => { await page.keyboard.press(key); await focus(locator); };
      const issueCount = () => page.evaluate(() => Number(document.body.dataset.issues ?? 0));
      const finish = outcome => page.evaluate(detail => window.dispatchEvent(new CustomEvent('fixture-issue-result', { detail })), outcome);
      const snapshot = async state => {
        await page.evaluate(() => document.fonts.ready);
        const evidence = `owner-invite-${state}-${size}`;
        await page.screenshot({ path: resolve(output, `${evidence}.png`), fullPage: true, animations: 'disabled' });
        return evidence;
      };
      await page.evaluate(axe);
      const audit = async state => {
        const evidence = await snapshot(state);
        const results = await page.evaluate(() => window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
        }));
        await writeFile(resolve(output, `axe-${evidence}.json`), JSON.stringify(results, null, 2));
        assert.equal(results.violations.length, 0, `axe violations for ${evidence}: ${JSON.stringify(results.violations)}`);
      };

      await open.waitFor();
      await tab(open);
      await page.keyboard.press('Enter');
      await focus(name);
      assert.equal(await dialog.evaluate(el => el.matches(':modal')), true);
      await audit('create');
      assert.equal(await dialog.evaluate(el => {
        const rect = el.getBoundingClientRect();
        return document.documentElement.scrollWidth <= innerWidth && el.scrollWidth <= el.clientWidth &&
          (innerWidth <= 820 ? rect.width === innerWidth && rect.bottom === innerHeight : rect.bottom < innerHeight && rect.left > 0);
      }), true);
      await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
      assert.equal(await name.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).outlineStyle === 'solid' && !document.getAnimations().length), true);
      await snapshot('forced-colours-focus');
      if (width === 320) continue;
      await page.emulateMedia({ forcedColors: 'none' });

      await tab(note); await tab(make); await tab(cancel); await tab(close); await tab(cancel, 'Shift+Tab');
      await page.keyboard.press('Escape');
      await focus(open);
      await open.press('Enter');
      await note.fill('🙂'.repeat(141));
      await make.press('Enter');
      await focus(note);
      assert.equal(await note.getAttribute('aria-invalid'), 'true');
      assert.equal(await issueCount(), 0);
      await audit('validation');
      await name.fill('  Pell  ');
      await note.fill('  Welcome to Drive!  ');
      await tab(make);
      await page.keyboard.press('Enter');
      const saving = dialog.getByRole('button', { name: 'Making invite link…' });
      await focus(saving);
      assert.equal(await saving.getAttribute('aria-busy'), 'true');
      for (const field of [name, note]) assert.equal(await field.isEditable(), false);
      for (const control of [cancel, close]) assert.equal(await control.getAttribute('aria-disabled'), 'true');
      await page.keyboard.press('Enter');
      await page.mouse.click(2, 2);
      assert.equal(await issueCount(), 1);
      assert.equal(await dialog.isVisible(), true);
      assert.deepEqual(await page.evaluate(() => JSON.parse(document.body.dataset.metadata)), { displayName: 'Pell', note: 'Welcome to Drive!' });
      await audit('saving');
      await finish('not-issued');
      await focus(name);
      assert.equal(await name.inputValue(), '  Pell  ');
      assert.equal(await note.inputValue(), '  Welcome to Drive!  ');
      await dialog.getByRole('alert').filter({ hasText: "That invite wasn't made. Try again." }).waitFor();
      await audit('not-issued');

      await make.click();
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      assert.equal(await saving.isVisible(), true, 'two Escapes must not close the saving dialog');
      await finish('issued');
      await focus(copy);
      const link = dialog.getByRole('textbox', { name: 'Invite link for Pell' });
      const expected = `${origin}/invite#${'fixture_'.padEnd(43, 'x')}`;
      assert.equal(await link.inputValue(), expected);
      assert.equal(await link.isEditable(), false);
      await dialog.getByText("Send it to Pell yourself. It works once and expires on 21 Nov. You won't see this link again.").waitFor();
      assert.equal(await copy.evaluate(el => getComputedStyle(el.parentElement).flexDirection), width === 390 ? 'column' : 'row');
      await audit('link');
      await page.keyboard.press('Enter');
      const copied = dialog.getByRole('button', { name: 'Copied' });
      await copied.waitFor();
      await dialog.getByRole('status').filter({ hasText: 'Link copied' }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
      await snapshot('copied');
      await copy.waitFor({ timeout: 5000 });

      await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new DOMException('', 'NotAllowedError')); });
      await page.keyboard.press('Enter');
      await focus(link);
      assert.equal(await link.evaluate(el => el.selectionStart === 0 && el.selectionEnd === el.value.length), true);
      await dialog.getByRole('alert').filter({ hasText: 'Press Ctrl+C or ⌘C to copy.' }).waitFor();
      await audit('clipboard-refused');
      const greyscale = await page.addStyleTag({ content: 'html, dialog:modal { filter: grayscale(1); } dialog:modal::backdrop { backdrop-filter: grayscale(1); filter: grayscale(1); }' });
      await snapshot('greyscale');
      await greyscale.evaluate(el => el.remove());
      await tab(copy); await tab(done);
      await page.keyboard.press('Enter');
      await focus(open);
      assert.equal(await page.locator('dialog input[readonly]').count(), 0);
      assert.equal(await issueCount(), 2);
      assert.equal(page.url(), fixture);
      assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);

      await page.keyboard.press('Enter');
      await focus(name);
      assert.equal(await name.inputValue(), '');
      assert.equal(await note.inputValue(), '');
      await name.press('Enter');
      await saving.waitFor();
      assert.deepEqual(await page.evaluate(() => JSON.parse(document.body.dataset.metadata)), { displayName: null, note: null });
      await finish('uncertain');
      await focus(done);
      await dialog.getByRole('alert').filter({ hasText: 'The invite may have been made' }).waitFor();
      await audit('uncertain');
      assert.equal(await make.count(), 0);
      assert.equal(await issueCount(), 3);
      await page.mouse.click(2, 2);
      await focus(open);
      assert.equal(await dialog.isVisible(), false);
      await page.keyboard.press('Enter');
      await focus(done);
      assert.equal(await make.count(), 0);
      assert.equal(await issueCount(), 3);
      await page.keyboard.press('Escape');
      await focus(open);
      assert.deepEqual(unexpected, []);
      await writeFile(resolve(output, `keyboard-owner-invite-${size}.json`), JSON.stringify({
        initialFocus: 'Name', wrapsBothWays: true, escapeRestoresFocus: true, repeatedEscapePreservesResult: true,
        copyFocusedAndWritten: true, refusedSelectsFullLink: true, doneRestoresFocusAndClearsLink: true,
        unknownOutcomeDoesNotRetry: true
      }, null, 2));
      console.log(`Owner invite create, copy, recovery, keyboard and axe passed at ${size}`);
    } finally {
      await context.close();
    }
  }
}
