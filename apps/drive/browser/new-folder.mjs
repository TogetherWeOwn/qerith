import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function proveNewFolder(page, origin, DB, principal, intercept, listingIndex) {
  const owner = !!intercept;
  const opener = page.getByRole('button', { name: 'New folder', exact: true });
  const dialog = page.getByRole('dialog', { name: 'New folder in My Drive' });
  const field = dialog.getByRole('textbox', { name: 'Folder name' });
  const active = page.locator(':focus'), uploadReady = page.getByRole('button', { name: 'Upload', exact: true }).and(page.locator('[aria-disabled="false"]'));
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
  const folderId = name => DB.prepare("SELECT id FROM drive_entries WHERE name = ? AND owner_id = ? AND parent_id IS NULL AND kind = 'folder'")
    .bind(name, principal).first('id');
  const uploadFile = name => page.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('fixture') });
  const recovery = page.getByRole('link', { name: 'Refresh My Drive' });
  const captured = Promise.withResolvers(), releaseUpload = Promise.withResolvers();
  page.on('request', observe);
  try {
    for (const [width, height] of widths) {
      const evidence = state => capture(page, state, width, true, owner ? 'new-folder' : 'member-new-folder');
      await page.setViewportSize({ width, height });
      await page.goto(`${origin}/`); await uploadReady.waitFor();
      const name = `A Receipts ${width} 🗂️`; // Before the existing Folder NNN fixtures.
      const concurrent = owner && width === 1280;
      if (concurrent) {
        const upload = 'Concurrent success.txt';
        intercept('/__data.json', (route, relay) => relay(true, () => { captured.resolve(route.request()); return releaseUpload.promise; }));
        await uploadFile(upload);
        await status(`${upload}: Uploaded.`).waitFor();
        await Promise.race([captured.promise, new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Upload refresh never reached the delivery gate')), 8_000).unref();
        })]); // The Worker read the page before the folder exists.
      }
      await open();
      if (owner) {
        await evidence('open');
        for (const [key, target] of [['Shift+Tab', 'Close'], ['Shift+Tab', 'Cancel'], ['Tab', 'Close']]) {
          await page.keyboard.press(key);
          await dialog.getByRole('button', { name: target }).and(active).waitFor();
        }
        const before = requests.length;
        await field.press('Enter');
        await dialog.getByRole('alert').filter({ hasText: 'Type a name.' }).waitFor();
        await evidence('validation');
        for (const [invalid, text] of [[' . ', /only dots or spaces/], ['a/b', /only dots or spaces/], ['📁'.repeat(64), /That name is too long/]]) {
          await field.fill(invalid);
          await dialog.getByText(text).waitFor();
        }
        await cancel();
        await open();
        assert.deepEqual([await field.inputValue(), requests.length], ['', before]);
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
      const row = page.locator(`[data-created-row="${await folderId(name)}"]`).and(active);
      await row.waitFor();
      if (concurrent) {
        releaseUpload.resolve();
        const stale = await (await captured.promise).response();
        assert.equal(await stale.finished(), null);
        await page.waitForFunction(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))), null, { timeout: 5_000 });
        assert.deepEqual([await row.count(), await recovery.count()], [1, 0]);
      }
      assert.ok((await row.ariaSnapshot()).includes(name));
      await status(`Created “${name}”.`).waitFor();
      assert.deepEqual([page.url(), requests.length], [base, before + 1]);
      await evidence('success');
      if (width === 1280) {
        await row.evaluate(el => { el.closest('.listing').style.width = '390px'; el.blur(); });
        await row.and(page.locator('li')).waitFor();
      }
      if (!owner) continue;
      await page.reload(); await uploadReady.waitFor();
      await open();
      await submit(name, 409);
      await dialog.getByText(/There's already a folder/).waitFor();
      await field.and(active).waitFor();
      assert.equal(await field.inputValue(), name);
      await evidence('collision');
      await cancel();

      for (const [http, state] of [[404, 'denied'], [503, 'failure']]) {
        intercept('/api/folders', (route, relay) => http === 404 ? relay(false) : route.fulfill({ status: http }));
        await open();
        const before = requests.length;
        await submit(`${state} ${width}`, http);
        await dialog.getByRole('alert').and(active).waitFor();
        await evidence(state);
        assert.equal(requests.length, before + 1);
        await cancel();
      }
      await Promise.all([page.waitForURL('**/?page=*'), page.getByRole('link', { name: 'Next page' }).click()]);
      await uploadReady.waitFor();
      const continuation = page.url(), earlier = `B Earlier ${width}`;
      await open();
      await submit(earlier, 201);
      await opener.and(active).waitFor();
      await page.getByText('It isn’t on this page.', { exact: false }).waitFor();
      assert.deepEqual([page.url(), await page.getByText(earlier, { exact: true }).count()], [continuation, 0]);
      assert.ok(await folderId(earlier));
      await evidence('off-page');
      const nameAfterFailure = `Z Refresh failed ${width}`, attempts = requests.length;
      await open();
      if (!concurrent) intercept('/__data.json', route => route.abort());
      await submit(nameAfterFailure, 201);
      if (concurrent) {
        await page.locator('[data-created-row]').and(active).filter({ hasText: nameAfterFailure }).waitFor();
        intercept('/__data.json', async (_, relay) => {
          await DB.prepare('DROP INDEX drive_entries_listing_asc').run();
          await relay(true, () => DB.prepare(listingIndex).run());
        });
        const [read] = await Promise.all([page.waitForResponse('**/__data.json?*'), uploadFile('Later upload.txt')]);
        assert.equal(read.status(), 200);
        await page.getByText("This folder didn't load.", { exact: false }).waitFor();
      }
      await recovery.and(active).waitFor();
      await status(`Created “${nameAfterFailure}”. Refresh My Drive to see it.`).waitFor();
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
  } finally { releaseUpload.resolve(); page.off('request', observe); }
}
