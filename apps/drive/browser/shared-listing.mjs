import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function proveSharedListing(browser, { origin, DB, worker, relay, ownerCookie, memberToken, file, downloadPath }) {
  const flags = { 'x-fixture-invite': '1', 'x-fixture-shared': '1' };
  const member = `__Host-drive-session=${memberToken}`;
  const context = await browser.newContext();
  const output = process.env.DRIVE_BROWSER_EVIDENCE_DIR;
  const visit = (path, headers, method = 'GET') => worker.fetch(origin + path, { headers, method, redirect: 'manual' });
  const deny = async (path, headers, status, method) => {
    const response = await visit(path, headers, method);
    assert.deepEqual([response.status, response.headers.get('cache-control'), await response.text()],
      [status, 'private, no-store', ''], path);
  };
  const enabled = { ...flags, cookie: member };
  const id = downloadPath.split('/').at(-1);
  const grant = (entry) => DB.prepare('INSERT INTO drive_read_grants VALUES (?, ?)').bind(entry, 'member');
  const revoke = () => DB.prepare('DELETE FROM drive_read_grants WHERE recipient_id = ?').bind('member').run();
  try {
    await deny('/shared', { 'x-fixture-invite': '1', cookie: member }, 404);
    await deny('/shared', { 'x-fixture-shared': '1', cookie: member }, 404);
    await deny('/shared', { ...flags, cookie: ownerCookie }, 404);
    await deny('/shared', flags, 401);
    for (const path of ['/shared/', '/%73hared', '/shared/__data.json', '/shared/f/x', '/api/shared-listing']) {
      await deny(path, enabled, 404);
    }
    await deny('/shared', { ...enabled, origin }, 404, 'POST');
    await deny('/shared?x-sveltekit-invalidated=01', enabled, 400);
    await deny('/shared?cursor=%FF', enabled, 400);
    await deny(downloadPath, enabled, 404);

    await context.addCookies([{ name: '__Host-drive-session', value: memberToken, url: origin, secure: true, httpOnly: true }]);
    let shared = false;
    await context.route('**/*', route => relay(route, { fetch: (url, init) => worker.fetch(url, {
      ...init, headers: { ...init.headers, 'x-fixture-invite': '1', ...(shared ? flags : {}) },
    }) }, 'same-origin'));
    const page = await context.newPage();
    const link = page.getByRole('link', { name: 'Shared with me' });
    const main = page.getByRole('main');
    await page.goto(origin);
    assert.equal(await link.count(), 0);
    shared = true;
    const listed = page.getByRole('link', { name: file.name, exact: true });
    const folder = 'Receipts folder';
    const firstFolder = '~shared-01';
    await DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, 'owner', ?, 'folder')").bind(firstFolder, folder).run();
    const tab = async (name) => {
      await page.keyboard.press('Tab');
      const target = page.locator(':focus');
      assert.equal(await target.textContent(), name);
      assert.equal(await target.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
    };
    const enter = async () => {
      const [response] = await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
      assert.deepEqual([response?.status(), response?.headers()['cache-control'], response?.headers()['referrer-policy']],
        [200, 'private, no-store', 'no-referrer']);
    };
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height });
      await page.goto(origin);
      await tab('Skip to content');
      await tab('My Drive');
      await tab('Shared with me');
      await enter();
      assert.equal(await link.getAttribute('aria-current'), 'page');
      await main.getByRole('heading', { name: 'Nothing is shared with you yet.' }).waitFor();
      await capture(page, 'empty', width, true, 'staging-shared');
      await DB.batch([grant(id), grant(firstFolder)]);
      await page.reload();
      await listed.waitFor();
      await main.getByText(folder, { exact: true }).filter({ visible: true }).waitFor();
      assert.equal(await main.getByRole('link').count(), 1);
      assert.equal(await main.locator('button, input, form').count(), 0);
      assert.equal(await page.getByRole('link', { name: 'Users and invites' }).count(), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await capture(page, 'listed', width, true, 'staging-shared');
      await writeFile(resolve(output, `staging-shared-listed-${width}-tree.txt`), await main.ariaSnapshot());
      await tab('Skip to content');
      await page.keyboard.press('Enter');
      assert.equal(await main.evaluate(el => document.activeElement === el), true);
      await tab(file.name);
      const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
      assert.equal(download.suggestedFilename(), file.name);
      assert.deepEqual(await readFile(await download.path()), file.buffer);
      await writeFile(resolve(output, `staging-shared-keyboard-${width}.json`), JSON.stringify({
        viewport: [width, height], visibleFocus: true, skipToMain: true, keyboardDownload: true,
      }));
      await revoke();
      await page.reload();
      assert.equal(await listed.count(), 0);
      await deny(downloadPath, enabled, 404);
    }

    // IDs in the existing page contract are opaque and do not need to be UUIDs.
    await DB.batch([grant(id), grant(firstFolder), DB.prepare(`WITH RECURSIVE n(v) AS
      (VALUES (2) UNION ALL SELECT v + 1 FROM n WHERE v < 100)
      INSERT INTO drive_entries (id, owner_id, name, kind)
      SELECT printf('~shared-%03d:+', v), 'owner', printf('Shared folder %03d', v), 'folder' FROM n`),
    DB.prepare("INSERT INTO drive_read_grants SELECT id, 'member' FROM drive_entries WHERE id GLOB '~shared-???:+'")]);
    await page.goto(origin + '/shared');
    assert.equal(await main.getByText('100 items on this page').count(), 1);
    const next = main.getByRole('link', { name: 'Next page' });
    const cursor = await next.getAttribute('href');
    assert.ok(new URL(cursor, origin).searchParams.get('cursor').endsWith(':+'));
    await next.focus();
    await enter();
    assert.equal(await main.getByText('1 item on this page').count(), 1);
    await revoke();
    await page.reload();
    await main.getByText('No more items.').waitFor();
    const first = main.getByRole('link', { name: 'First page' });
    await first.focus();
    await enter();
    await main.getByRole('heading', { name: 'Nothing is shared with you yet.' }).waitFor();
  } finally {
    await context.close();
    await revoke();
    await DB.prepare("DELETE FROM drive_entries WHERE id GLOB '~shared-*'").run();
  }
}
