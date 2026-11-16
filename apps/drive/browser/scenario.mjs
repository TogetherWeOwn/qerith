import assert from 'node:assert/strict';

export const states = ['sign-in', 'waiting', 'cancelled', 'no-passkey', 'unsupported', 'revoked', 'rate-limited'];

export async function waitForFixture(page, state) {
  const title = state === 'revoked' ? 'Your access is turned off' : 'Sign in to Drive';
  await page.getByRole('heading', { name: title }).waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  const tree = await page.locator('section').ariaSnapshot();
  assert.match(tree, new RegExp(`heading "${title}" \\[level=1\\]`));
  if (state !== 'revoked') {
    const name = state === 'waiting' ? 'Waiting for your device…' : state === 'rate-limited' ? 'Try again in 1 min' : 'Sign in with a passkey';
    const inactive = ['waiting', 'unsupported', 'rate-limited'].includes(state);
    assert.equal(await page.getByRole('button', { name, exact: true, disabled: inactive }).count(), 1);
    assert.match(tree, new RegExp(`button "${name}"`));
    if (inactive) assert.match(tree, /\[disabled\]/);
    if (state === 'waiting') await assertBusy(page);
  }
}

async function assertBusy(page) {
  const session = await page.context().newCDPSession(page);
  const { nodes } = await session.send('Accessibility.getFullAXTree');
  await session.detach();
  const button = nodes.find(node => node.role?.value === 'button' && node.name?.value === 'Waiting for your device…');
  assert(button?.properties?.some(property => property.name === 'busy' && (property.value?.value === true || property.value?.value === 1)), 'Waiting button must be busy in the accessibility tree');
}

export async function exerciseWaitAnnouncement(page) {
  const status = page.getByRole('status');
  assert.equal(await status.count(), 1);
  assert.equal(await status.textContent(), '');
  await page.evaluate(() => window.dispatchEvent(new Event('fixture-wait')));
  await page.getByText("Follow your browser's prompt.").waitFor();
  const tree = await page.locator('section').ariaSnapshot();
  assert.match(tree, /status/);
  assert.match(tree, /Follow your browser's prompt\./);
  assert.match(tree, /button "Waiting for your device…".*\[disabled\]/);
  await assertBusy(page);
  return tree;
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
