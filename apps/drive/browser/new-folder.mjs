import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function proveNewFolder(page, origin, DB, principal, defaultWorker) {
  const owner = !!defaultWorker;
  const opener = page.getByRole('button', { name: 'New folder', exact: true });
  const dialog = page.getByRole('dialog', { name: 'New folder in My Drive' });
  const field = dialog.getByRole('textbox', { name: 'Folder name' });
  const active = page.locator(':focus');
  const post = request => request.url() === `${origin}/api/folders` && request.method() === 'POST';
  const data = response => new URL(response.url()).pathname === '/__data.json';
  const requests = [];
  const observe = request => { if (post(request)) requests.push(request.postDataJSON()); };
  const open = async () => { await opener.press('Enter'); await field.and(active).waitFor(); };
  const cancel = async () => { await page.keyboard.press('Escape'); await opener.and(active).waitFor(); };
  const submit = async (name, status) => {
    await field.fill(name);
    const [response] = await Promise.all([page.waitForResponse(r => post(r.request())), field.press('Enter')]);
    assert.equal(response.status(), status);
    assert.deepEqual(requests.at(-1), { name, parentId: null });
    return response;
  };
  const checkInsert = async name => {
    const row = await DB.prepare('SELECT id, owner_id, parent_id, kind FROM drive_entries WHERE name = ? AND owner_id = ?')
      .bind(name, principal).first();
    assert.deepEqual(row, { id: row?.id, owner_id: principal, parent_id: null, kind: 'folder' });
    return row.id;
  };
  page.on('request', observe);
  try {
    for (const [width, height] of widths) {
      const evidence = state => capture(page, state, width, true, owner ? 'new-folder' : 'member-new-folder');
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
      const name = `A Receipts ${width} 🗂️`; // Before the existing Folder NNN fixtures.
      await open();
      if (owner) {
        await evidence('open');
        await page.keyboard.press('Shift+Tab');
        await dialog.getByRole('button', { name: 'Close' }).and(active).waitFor();
        await page.keyboard.press('Shift+Tab');
        await dialog.getByRole('button', { name: 'Cancel' }).and(active).waitFor();
        await page.keyboard.press('Tab');
        await dialog.getByRole('button', { name: 'Close' }).and(active).waitFor();
        await field.fill('Discard me');
        const before = requests.length;
        await cancel();
        await open();
        assert.equal(await field.inputValue(), '');
        await field.press('Enter');
        await dialog.getByRole('alert').filter({ hasText: 'Type a name.' }).waitFor();
        await evidence('validation');
        for (const [invalid, text] of [[' . ', /only dots or spaces/], ['a/b', /only dots or spaces/], ['📁'.repeat(64), /That name is too long/]]) {
          await field.fill(invalid);
          await dialog.getByText(text).waitFor();
        }
        assert.equal(requests.length, before);
      }
      const held = Promise.withResolvers(), before = requests.length;
      if (owner) await page.route('**/api/folders', async route => { await held.promise; await route.fallback(); }, { times: 1 });
      const base = page.url(), refresh = page.waitForResponse(data);
      const saved = submit(name, 201);
      try {
        if (owner) {
          await dialog.getByRole('button', { name: 'Making folder…' }).waitFor();
          assert.equal(await field.getAttribute('readonly'), '');
          assert.equal(await dialog.getByRole('button', { name: 'Cancel' }).getAttribute('aria-disabled'), 'true');
          await page.keyboard.press('Escape');
          await field.press('Enter');
          assert.equal(await dialog.count(), 1);
          await evidence('pending');
        }
      } finally { held.resolve(); }
      await saved;
      assert.equal((await refresh).headers()['cache-control'], 'private, no-store');
      assert.equal(requests.length, before + 1);
      const rowId = await checkInsert(name);
      const row = page.locator(`[data-created-row="${rowId}"]`).and(active);
      await row.waitFor();
      assert.ok((await row.ariaSnapshot()).includes(name));
      await page.getByRole('status').filter({ hasText: `Created “${name}”.` }).waitFor();
      assert.equal(page.url(), base);
      await evidence('success');
      if (width === 1280) {
        await row.evaluate(el => { el.closest('.listing').style.width = '390px'; el.blur(); });
        await row.and(page.locator('li')).waitFor();
      }
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByText(name, { exact: true }).filter({ visible: true }).waitFor();
      if (!owner) continue;

      await open();
      await submit(name, 409);
      await dialog.getByText(/There's already a folder/).waitFor();
      await field.and(active).waitFor();
      assert.equal(await field.inputValue(), name);
      await evidence('collision');
      await cancel();

      const assertFailure = async (name, status, state) => {
        await open();
        const before = requests.length;
        await submit(name, status);
        await dialog.getByRole('alert').and(active).waitFor();
        await evidence(state);
        assert.equal(requests.length, before + 1);
        await cancel();
      };
      await page.route('**/api/folders', async route => {
        const request = route.request();
        const response = await defaultWorker.fetch(request.url(), { method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer(), redirect: 'manual' });
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }, { times: 1 });
      await assertFailure(`Denied ${width}`, 404, 'denied');
      await DB.prepare(`CREATE TRIGGER fixture_new_folder_error BEFORE INSERT ON drive_entries
        WHEN NEW.name LIKE 'Unavailable %' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`).run();
      try { await assertFailure(`Unavailable ${width}`, 503, 'failure'); }
      finally { await DB.prepare('DROP TRIGGER fixture_new_folder_error').run(); }
      const assertRecovery = async name => {
        const before = requests.length;
        await submit(name, 201);
        await page.getByRole('link', { name: 'Refresh My Drive' }).and(active).waitFor();
        await page.getByRole('status').filter({ hasText: `Created “${name}”. Refresh My Drive to see it.` }).waitFor();
        await checkInsert(name);
        assert.equal(requests.length, before + 1);
        assert.equal(page.url(), base);
      };
      const index = await DB.prepare("SELECT sql FROM sqlite_schema WHERE name = 'drive_entries_listing_asc'").first('sql');
      await open();
      await DB.prepare('DROP INDEX drive_entries_listing_asc').run();
      try { await assertRecovery(`Listing unavailable ${width}`); }
      finally { await DB.prepare(index).run(); }
      await open();
      await page.route('**/__data.json?*', route => width === 390 ? route.abort() : route.fulfill({ status: 503 }), { times: 1 });
      await assertRecovery(`Refresh failed ${width}`);
      await evidence('refresh-failed');

      // The staging fixture already has 99 Folder NNN rows plus the named folders.
      await page.getByRole('link', { name: 'Next page' }).click();
      await open();
      const continuation = page.url(), earlier = `B Earlier ${width}`;
      await submit(earlier, 201);
      await opener.and(active).waitFor();
      await page.getByText('It isn’t on this page.', { exact: false }).waitFor();
      assert.equal(page.url(), continuation);
      assert.equal(await page.locator(`[data-created-row="${await checkInsert(earlier)}"]`).count(), 0);
      await evidence('off-page');
    }
    await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, `${owner ? 'owner' : 'member'}-new-folder.json`), JSON.stringify({
      testedSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), session: 'signed in with passkey', viewports: widths,
      posts: requests, persistedInD1: true, authenticatedRootRefresh: true, stayedInMyDrive: true,
      initialFocus: 'Folder name', successFocus: 'created row', keyboard: 'Enter creates, Escape returns focus; owner Tab wraps',
      screenReaderEvidence: 'Chromium accessibility tree checked on focused row; not a native screen reader run',
    }, null, 2));
  } finally { page.off('request', observe); }
}
