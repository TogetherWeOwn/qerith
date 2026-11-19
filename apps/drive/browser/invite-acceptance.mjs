import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const variants = ['valid', 'unnamed', 'waiting', 'cancelled', 'unsupported', 'dead-link', 'signed-in', 'rate-limited', 'long-note'];

export async function exerciseInviteAcceptance(browser, origin, axe, output) {
  for (const [width, height] of [[1280, 800], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    try {
      const page = await context.newPage();
      const heading = page.getByRole('heading', { level: 1 });
      const field = page.getByRole('textbox', { name: 'Your name' });
      const button = page.getByRole('button', { name: 'Set up a passkey', exact: true });
      const waiting = page.getByRole('button', { name: 'Waiting for your device…' });
      const status = page.getByRole('status');
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
      const focused = locator => locator.and(page.locator(':focus')).waitFor({ timeout: 5000 });
      const dataset = key => page.evaluate(key => document.body.dataset[key], key);
      const load = variant => page.goto(`${origin}/?invite=${variant}`, { waitUntil: 'networkidle' });

      async function capture(variant) {
        const evidence = `invite-${variant}-${width}x${height}`;
        await page.screenshot({ path: resolve(output, `${evidence}.png`), fullPage: true });
        await writeFile(resolve(output, `${evidence}-tree.txt`), await page.getByRole('main').ariaSnapshot());
        await page.evaluate(axe);
        const results = await page.evaluate(() => window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }
        }));
        await writeFile(resolve(output, `axe-${evidence}.json`), JSON.stringify(results, null, 2));
        assert.equal(results.violations.length, 0, `axe violations for ${evidence}: ${JSON.stringify(results.violations)}`);
      }

      for (const variant of variants) {
        await load(variant);
        await heading.waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.title(), 'Accept invite · Drive');
        assert.equal(await page.getByRole('navigation').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        switch (variant) {
          case 'valid':
            assert.equal(await heading.innerText(), 'Mora invited you to Drive');
            assert.equal(await page.locator('blockquote').textContent(), 'Welcome to Drive!');
            assert.equal(await field.inputValue(), 'Pell');
            break;
          case 'unnamed':
            assert.equal(await heading.innerText(), "You're invited to Drive");
            assert.equal(await field.inputValue(), '');
            assert.equal(await page.locator('blockquote').count(), 0);
            break;
          case 'long-note':
            assert.equal(await page.locator('blockquote').textContent(), '<b>' + 'ع'.repeat(133) + '</b>');
            assert.equal(await page.locator('blockquote b').count(), 0);
            break;
          case 'dead-link':
            assert.equal(await heading.innerText(), "This link doesn't work any more");
            assert.equal(await page.getByText('Invite and sign-in links work once and expire after 7 days. Ask the owner for a new one.').count(), 1);
            assert.equal(await page.getByRole('button').count(), 0);
            break;
          case 'signed-in':
            assert.equal(await heading.innerText(), "You're signed in as Juno");
            assert.equal(await page.getByText("This invite is for someone else, so it wasn't used.").count(), 1);
            assert.equal(await page.getByRole('link', { name: 'Go to My Drive' }).getAttribute('href'), '/');
            assert.equal(await field.count(), 0);
            break;
          case 'waiting':
            assert.equal(await waiting.getAttribute('aria-busy'), 'true');
            assert.equal(await cancel.isVisible(), true);
            break;
          case 'cancelled':
            assert.equal(await page.getByRole('alert').filter({ hasText: "Nothing was saved. Try again when you're ready." }).count(), 1);
            break;
          case 'unsupported':
          case 'rate-limited': {
            const unavailable = variant === 'unsupported' ? button : page.getByRole('button', { name: 'Try again in 1 min' });
            assert.equal(await unavailable.getAttribute('aria-disabled'), 'true');
            assert.match(await status.textContent(), variant === 'unsupported' ? /This browser can't use passkeys/ : /Too many tries/);
            await field.press('Enter');
            assert.equal(await dataset('attempts'), undefined);
            break;
          }
        }
        await capture(variant);
      }

      await load('valid');
      await page.keyboard.press('Tab');
      await focused(field);
      await field.fill('   ');
      await field.press('Enter');
      await focused(field);
      assert.equal(await field.getAttribute('aria-invalid'), 'true');
      await page.getByRole('alert').filter({ hasText: 'Type a name.' }).waitFor();
      assert.equal(await dataset('attempts'), undefined);
      await capture('name-error');
      await field.pressSequentially('x'.repeat(65));
      assert.equal((await field.inputValue()).length, 64);
      await field.fill('  Péll  ');
      await page.keyboard.press('Tab');
      await focused(button);
      await page.keyboard.press('Enter');
      await focused(waiting);
      assert.equal(await dataset('name'), 'Péll');
      assert.equal(await field.getAttribute('readonly'), '');
      assert.equal(await field.inputValue(), '  Péll  ');
      await page.keyboard.press('Enter');
      assert.equal(await dataset('attempts'), '1');
      await page.keyboard.press('Tab');
      await focused(cancel);
      await page.keyboard.press('Enter');
      await focused(button);
      assert.equal(await field.inputValue(), '  Péll  ');
      await page.keyboard.press('Enter');
      await focused(waiting);
      assert.equal(await dataset('attempts'), '2');
      await page.evaluate(() => window.dispatchEvent(new Event('fixture-expire-invite')));
      await focused(heading);
      assert.equal(await field.count(), 0);
      assert.equal(await page.locator('blockquote').count(), 0);
      await writeFile(resolve(output, `invite-keyboard-${width}x${height}.json`), JSON.stringify({
        focusOrder: ['Your name', 'Set up a passkey', 'Cancel', 'Set up a passkey', "This link doesn't work any more"],
        blankRejected: true, duplicateWhileWaitingRejected: true, retryKeepsEditedName: true
      }, null, 2));
      console.log(`Invite acceptance: ${variants.length} screenshot/axe states and keyboard flow passed at ${width}x${height}`);
    } finally {
      await context.close();
    }
  }
}
