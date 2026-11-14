import assert from 'node:assert/strict';

export const states = ['sign-in', 'waiting', 'cancelled', 'no-passkey', 'unsupported', 'revoked', 'rate-limited'];

export async function waitForFixture(page, state) {
  const title = state === 'revoked' ? 'Your access is turned off' : 'Sign in to Drive';
  await page.getByRole('heading', { name: title }).waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
}

export async function exerciseKeyboard(page, state) {
  const buttons = page.getByRole('button');
  if (state === 'revoked') {
    assert.equal(await buttons.count(), 0);
    return { buttons: 0 };
  }
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  const primary = buttons.first();
  assert.equal(focused, (await primary.textContent()).trim());
  const inactive = ['waiting', 'unsupported', 'rate-limited'].includes(state);
  assert.equal(await primary.getAttribute('aria-disabled'), String(inactive));
  await page.keyboard.press('Enter');
  const requests = await page.locator('output').getAttribute('data-requests');
  assert.equal(requests, inactive ? '0' : '1');
  if (state === 'waiting') {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Cancel');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('output').getAttribute('data-cancellations'), '1');
  }
  return { focused, requests, inactive, cancellations: await page.locator('output').getAttribute('data-cancellations') };
}
