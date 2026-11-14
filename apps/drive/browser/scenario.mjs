import assert from 'node:assert/strict';

// Replace these fixture-specific checks alongside the test component.
export async function waitForFixture(page) {
  await page.getByRole('button', { name: 'Activate fixture' }).waitFor({ state: 'visible' });
  await page.getByText('Not activated', { exact: true }).waitFor({ state: 'visible' });
}

export async function exerciseKeyboard(page) {
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  assert.equal(focused, 'Activate fixture');
  await page.keyboard.press('Enter');
  const status = await page.getByRole('status').textContent();
  assert.equal(status, 'Activated');
  return [{ key: 'Tab', focused }, { key: 'Enter', status }];
}
