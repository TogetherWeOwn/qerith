import assert from 'node:assert/strict';

// Replace this fixture-specific scenario alongside the test component.
export async function exerciseKeyboard(page) {
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  assert.equal(focused, 'Activate fixture');
  await page.keyboard.press('Enter');
  const status = await page.getByRole('status').textContent();
  assert.equal(status, 'Activated');
  return [{ key: 'Tab', focused }, { key: 'Enter', status }];
}
