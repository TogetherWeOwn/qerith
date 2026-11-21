import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function exerciseShareRecipient(browser, origin, axe, output) {
  for (const [width, height] of [[1280, 800], [390, 844], [320, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const unexpected = [];
    try {
      await context.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === origin && !url.pathname.startsWith('/api/') && request.method() === 'GET') return route.continue();
        unexpected.push([request.method(), url.pathname]);
        return route.abort();
      });
      await context.routeWebSocket('**/*', socket => socket.close());
      const page = await context.newPage();
      page.on('pageerror', error => unexpected.push(error.message));
      page.on('response', response => { if (response.status() >= 400) unexpected.push(response.status()); });
      await page.goto(`${origin}/?share-recipient`);
      const main = page.getByRole('main');
      const input = page.getByRole('combobox', { name: 'Add people' });
      const list = page.getByRole('listbox', { name: 'Available people' });
      const status = page.getByRole('status');
      const key = key => page.keyboard.press(key);
      const selection = async (...ids) => assert.deepEqual(JSON.parse(await main.getAttribute('data-selection')), ids.map(n => `fixture-choice-${n}`));
      const focused = async () => assert(await input.evaluate(el => el === document.activeElement));
      const screenshot = stage => page.screenshot({ path: resolve(output, `share-recipient-${width}-${stage}.png`) });
      const evidence = {};
      const capture = async stage => {
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${stage}: no horizontal overflow`);
        const result = await page.evaluate(() => window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        }));
        await writeFile(resolve(output, `axe-share-recipient-${width}-${stage}.json`), JSON.stringify(result, null, 2));
        assert.equal(result.violations.length, 0, `${stage}: ${JSON.stringify(result.violations)}`);
        await screenshot(stage);
        evidence[stage] = await main.ariaSnapshot();
        assert(!/fixture-choice-|Invited /.test(evidence[stage]), 'No IDs or invented invitation dates in the accessibility tree');
      };
      await input.waitFor();
      await page.evaluate(axe);
      await page.evaluate(() => document.fonts.ready);
      await capture('empty');
      await key('Tab');
      await focused();
      await key('ArrowDown');
      const sam = list.getByRole('option', { name: 'Sam Mora' });
      assert.equal(await input.getAttribute('aria-activedescendant'), await sam.getAttribute('id'));
      assert.equal(await sam.getAttribute('aria-selected'), 'true');
      assert.equal(await list.getByRole('option', { name: '<b>Riley & Co.</b>' }).locator('b').count(), 0);
      await list.getByRole('option', { name: 'Name unavailable' }).waitFor();
      await capture('options');
      assert(await list.evaluate(el => el.scrollHeight > el.clientHeight), 'Listbox must overflow');
      await key('Tab');
      assert.equal(await list.count(), 0, 'Forward Tab closes the overflowing listbox');
      assert(await page.getByRole('button', { name: 'Continue' }).evaluate(el => el.matches(':focus-visible')));
      await key('Shift+Tab');
      await focused();
      await input.fill('ΟΣ');
      assert.equal(await list.getByRole('option', { name: 'ΟΣΑ', exact: true }).count(), 1, 'Greek prefix matches across sigma forms');
      await key('Escape');
      assert.equal(await list.count(), 0);
      await input.fill('sam mora');
      await key('Enter');
      await selection();
      for (const [edit, expected] of [['ArrowLeft', 3], ['ArrowRight', 5], ['click', null]]) {
        await input.evaluate(el => el.setSelectionRange(4, 4));
        await key('ArrowDown');
        assert.equal(await input.getAttribute('aria-activedescendant'), await sam.getAttribute('id'));
        if (edit === 'click') await input.click({ position: { x: 16, y: 16 } });
        else await key(edit);
        const caret = await input.evaluate(el => el.selectionStart);
        assert(expected === null ? caret > 0 && caret < 8 && caret !== 4 : caret === expected, `${edit}: caret moved`);
        assert.equal(await input.getAttribute('aria-activedescendant'), null, edit);
        await key('Enter');
        await selection();
        assert.equal(await main.getAttribute('data-submits'), '0', edit);
      }
      await key('ArrowDown');
      await key('Enter');
      await selection(1);
      assert.equal(await status.textContent(), 'Sam Mora selected. 1 selected.');
      await focused();
      await key('ArrowDown');
      assert.equal(await sam.count(), 0, 'Picked choice is filtered out');
      await input.fill('sam mora');
      assert.equal(await status.textContent(), 'Matching people are already selected.');
      await key('Enter');
      await selection(1);
      assert.equal(await list.count(), 0);
      await capture('already-selected');
      await key('Escape');
      assert.equal(await status.textContent(), '');
      await input.fill('');
      await list.getByRole('option', { name: 'Zoë Chen' }).click();
      await selection(1, 2);
      const chips = page.getByRole('list', { name: 'Selected people' });
      assert.equal(await chips.getByRole('listitem').count(), 2);
      assert.equal(await chips.getByRole('listitem').getByRole('button', { name: 'Remove Sam Mora' }).count(), 1);
      await capture('picked');

      await input.fill('someone@example.test');
      await key('Enter');
      assert.equal(await list.count(), 0);
      assert.equal(await status.textContent(), 'Nobody called “someone@example.test” is on this drive. The owner can invite them.');
      await selection(1, 2);
      assert.equal(await main.getAttribute('data-submits'), '0', 'Enter never implicitly submits the containing form');
      await capture('no-match');
      await key('Escape');
      await input.fill('');
      await key('ArrowUp');
      await key('Enter');
      await selection(1, 2, 6);
      assert.equal(await status.textContent(), 'Name unavailable selected. 3 selected.');

      const remove = name => page.getByRole('button', { name: `Remove ${name}`, exact: true });
      await key('ArrowDown');
      await key('Shift+Tab');
      assert.equal(await list.count(), 0, 'Tab navigation dismisses the popover');
      assert(await remove('Name unavailable').evaluate(el => el.matches(':focus-visible')));
      await key('Tab');
      await focused();
      for (const [name, ids] of [['Name unavailable', [1, 2]], ['Zoë Chen', [1]], ['Sam Mora', []]]) {
        await key('Shift+Tab');
        assert(await remove(name).evaluate(el => el.matches(':focus-visible')));
        await key('Space');
        await selection(...ids);
        await focused();
        assert.equal(await status.textContent(), `${name} removed. ${ids.length} selected.`);
      }
      assert.deepEqual(unexpected, []);
      assert.equal(await main.evaluate(el => el.getAnimations({ subtree: true }).length), 0);
      await key('ArrowDown');
      const greyscale = await page.addStyleTag({ content: 'main { filter: grayscale(1); }' });
      await screenshot('greyscale');
      await greyscale.evaluate(el => el.remove());
      await page.emulateMedia({ forcedColors: 'active' });
      assert(await input.evaluate(el => getComputedStyle(el.parentElement).outlineStyle === 'solid'));
      assert(await list.getByRole('option', { selected: true }).evaluate(el => getComputedStyle(el).outlineStyle === 'solid'));
      await screenshot('forced-colours');
      await writeFile(resolve(output, `share-recipient-${width}-keyboard.json`), JSON.stringify(evidence, null, 2));
      console.log(`Share recipient selection, clearing, caret editing, overflow Tab, Greek prefix, reflow and axe passed at ${width}×${height}`);
    } finally {
      await context.close();
    }
  }
}
