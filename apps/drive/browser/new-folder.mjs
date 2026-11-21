import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function proveNewFolder(page, origin, DB, principal, intercept) {
  const owner = !!intercept;
  const opener = page.getByRole('button', { name: 'New folder', exact: true });
  const dialog = page.getByRole('dialog', { name: 'New folder in My Drive' });
  const field = dialog.getByRole('textbox', { name: 'Folder name' });
  const active = page.locator(':focus');
  const status = text => page.getByRole('status').filter({ hasText: text });
  const post = request => request.url() === `${origin}/api/folders` && request.method() === 'POST';
  const requests = [];
  const observe = request => { if (post(request)) requests.push(request.postDataJSON()); };
  const open = async () => { await opener.press('Enter'); await field.and(active).waitFor(); };
  const cancel = async () => { await page.keyboard.press('Escape'); await opener.and(active).waitFor(); };
  const submit = async (name, status) => {
    await field.fill(name);
    const [response] = await Promise.all([page.waitForResponse(r => post(r.request())), field.press('Enter')]);
    assert.deepEqual([response.status(), requests.at(-1)], [status, { name, parentId: null }]);
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
        for (const [key, target] of [['Shift+Tab', 'Close'], ['Shift+Tab', 'Cancel'], ['Tab', 'Close']]) {
          await page.keyboard.press(key);
          await dialog.getByRole('button', { name: target }).and(active).waitFor();
        }
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
      intercept?.('/api/folders', async (_, relay) => { await held.promise; return relay(); });
      const base = page.url(), refresh = page.waitForResponse('**/__data.json?*');
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
      const row = page.locator(`[data-created-row="${await checkInsert(name)}"]`).and(active);
      await row.waitFor();
      assert.ok((await row.ariaSnapshot()).includes(name));
      await status(`Created “${name}”.`).waitFor();
      assert.deepEqual([page.url(), requests.length], [base, before + 1]);
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
      intercept('/api/folders', (_, relay) => relay(false));
      await assertFailure(`Denied ${width}`, 404, 'denied');
      await DB.prepare(`CREATE TRIGGER fixture_new_folder_error BEFORE INSERT ON drive_entries
        WHEN NEW.name LIKE 'Unavailable %' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`).run();
      try { await assertFailure(`Unavailable ${width}`, 503, 'failure'); }
      finally { await DB.prepare('DROP TRIGGER fixture_new_folder_error').run(); }
      await Promise.all([page.waitForURL('**/?page=*'), page.getByRole('link', { name: 'Next page' }).click()]);
      await page.getByRole('button', { name: 'Upload', exact: true }).and(page.locator('[aria-disabled="false"]')).waitFor();
      const continuation = page.url(), earlier = `B Earlier ${width}`;
      await open();
      await submit(earlier, 201);
      await opener.and(active).waitFor();
      await page.getByText('It isn’t on this page.', { exact: false }).waitFor();
      assert.equal(page.url(), continuation);
      assert.equal(await page.locator(`[data-created-row="${await checkInsert(earlier)}"]`).count(), 0);
      await evidence('off-page');
      const upload = 'Concurrent upload.txt', release = Promise.withResolvers();
      const recovery = page.getByRole('link', { name: 'Refresh My Drive' });
      const nameAfterFailure = `Z Refresh failed ${width}`, attempts = requests.length;
      intercept('/api/uploads', async route => { await release.promise; return route.fulfill({ status: 503 }); });
      try {
        await page.locator('input[type=file]').setInputFiles({ name: upload, mimeType: 'text/plain', buffer: Buffer.from('fixture') });
        await status(`Uploading ${upload}`).waitFor();
        await open();
        intercept('/__data.json', route => width === 390 ? route.abort() : route.fulfill({ status: 503 }));
        await submit(nameAfterFailure, 201);
        await recovery.and(active).waitFor();
      } finally { release.resolve(); }
      await status(`${upload}: Upload interrupted.`).waitFor();
      assert.equal(await recovery.and(active).count(), 1);
      await status(`Created “${nameAfterFailure}”. Refresh My Drive to see it.`).waitFor();
      await checkInsert(nameAfterFailure);
      await evidence('refresh-failed');
      const [document] = await Promise.all([
        page.waitForResponse(r => r.request().isNavigationRequest() && r.url() === continuation), recovery.press('Enter'),
      ]);
      assert.deepEqual([document.request().method(), document.status(), requests.length], ['GET', 200, attempts + 1]);
      await page.getByRole(width === 1280 ? 'table' : 'list').getByText(nameAfterFailure, { exact: true }).waitFor();
    }
    await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, `${owner ? 'owner' : 'member'}-new-folder.json`), JSON.stringify({
      testedSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), viewports: widths, posts: requests,
      keyboard: 'Textbox → created row; owner: Tab wraps, Escape returns focus, refresh link reloads the same cursor',
      screenReaderEvidence: 'Chromium accessibility tree checked on focused row; not a native screen reader run',
    }, null, 2));
  } finally { page.off('request', observe); }
}
