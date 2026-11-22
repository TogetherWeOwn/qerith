import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function proveMove(page, { origin, DB, intercept, file, downloadPath }) {
  const folder = (id, label, parent = null) => DB.prepare(`INSERT INTO drive_entries
    (id, owner_id, parent_id, name, kind) VALUES (?, 'owner', ?, ?, 'folder')`).bind(id, parent, label).run();
  const active = page.locator(':focus'), link = name => page.getByRole('link', { name, exact: true });
  for (const [width, height] of widths) {
    console.log(`Move picker (${width}×${height})`);
    const movingFile = width === 1280;
    const name = movingFile ? file.name : '! Move A source';
    const source = movingFile ? downloadPath.split('/').at(-1) : 'move-source';
    const target = `move-taxes-${width}`, missing = `move-deleted-${width}`;
    const taxes = `! Move B Taxes ${width}`, deleted = '! Move C Deleted', archive = `! Move D Archive ${width}`;
    if (!movingFile) await folder(source, name);
    await folder(target, taxes);
    await folder(`${target}-duplicate`, name, target);
    await folder(missing, deleted);
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    const trigger = page.getByRole('button', { name: `Actions for ${name}`, exact: true });
    const dialog = page.getByRole('dialog', { name: /^Move “/ });
    const button = label => dialog.getByRole('button', { name: label, exact: true });
    const heading = label => dialog.getByRole('heading', { name: label, exact: true }).and(active);
    const evidence = state => capture(page, state, width, true, 'owner-move');
    if (movingFile) assert.equal(await link(name).getAttribute('href'), downloadPath);
    const open = async () => {
      await trigger.press('ArrowDown');
      await page.getByRole('menuitem', { name: 'Move', exact: true }).press('Enter');
      await button(taxes).waitFor();
    };
    const path = `/api/entries/${source}`, writes = [];
    const matches = request => request.method() === 'PATCH' && new URL(request.url()).pathname === path;
    const track = request => { if (matches(request)) writes.push(request.postDataJSON()); };
    const submit = async label => (await Promise.all([
      page.waitForResponse(r => matches(r.request())), button(label).press('Enter')]))[0].status();
    page.on('request', track);
    try {
      await open();
      await heading('My Drive').waitFor();
      for (const [key, label] of [['Shift+Tab', 'Close'], ['Shift+Tab', 'Cancel'], ['Tab', 'Close']]) {
        await page.keyboard.press(key);
        await button(label).and(active).waitFor();
      }
      for (const label of movingFile ? ['Move to My Drive'] : [name, 'Move to My Drive']) {
        assert.equal(await button(label).getAttribute('aria-disabled'), 'true');
        await button(label).press('Enter');
      }
      assert.equal(writes.length, 0);
      await evidence('open');
      await page.keyboard.press('Escape');
      await trigger.and(active).waitFor();
      await open();
      await button(taxes).press('Space');
      await heading(`My Drive / ${taxes}`).waitFor();
      assert.equal(await submit(`Move to ${taxes}`), 409);
      const alert = dialog.getByRole('alert').and(active);
      await alert.filter({ hasText: `There's already an item called “${name}” in ${taxes}. Rename one of them first.` }).waitFor();
      await evidence('conflict');
      await button('Up to My Drive').press('Enter');
      await button(deleted).press('Enter');
      await heading(`My Drive / ${deleted}`).waitFor();
      await DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(missing).run();
      assert.equal(await submit(`Move to ${deleted}`), 404);
      await alert.filter({ hasText: 'Pick another one.' }).waitFor();
      assert.equal(await button(`Move to ${deleted}`).getAttribute('aria-disabled'), 'true');
      await evidence('gone');
      await button('Up to My Drive').press('Enter');
      if (movingFile) await button(taxes).press('Enter');
      const parent = movingFile ? taxes : 'My Drive';
      await heading(movingFile ? `My Drive / ${taxes}` : parent).waitFor();
      await button('New folder').press('Enter');
      const input = page.getByRole('dialog', { name: `New folder in ${parent}` }).getByRole('textbox', { name: 'Folder name' });
      await input.and(active).fill(archive);
      await input.press('Enter');
      await heading(`My Drive / ${movingFile ? `${taxes} / ` : ''}${archive}`).waitFor();
      const status = page.locator('[data-drive-announcements]').getByRole('status');
      const hold = Promise.withResolvers();
      intercept(path, async (_, relay) => { await hold.promise; return relay(); });
      const pending = submit(`Move to ${archive}`);
      try {
        await button('Moving…').waitFor();
        assert.equal(await button('Moving…').getAttribute('aria-busy'), 'true');
        await page.keyboard.press('Escape');
        await button('Close').click({ force: true });
        await page.mouse.click(1, 1);
        assert.equal(await dialog.isVisible(), true, 'pending move cannot be dismissed');
        await evidence('saving');
        if (movingFile) intercept('/__data.json', route => route.fulfill({ status: 503 }));
      } finally { hold.resolve(); }
      assert.equal(await pending, 200);
      const openArchive = link(`Open ${archive}`);
      const moveMessage = `Moved to ${archive}`;
      const receipt = movingFile ? moveMessage : `Created “${archive}”. ${moveMessage}`;
      await status.filter({ hasText: receipt }).waitFor();
      assert.equal(await status.textContent(), receipt);
      const destination = (await openArchive.getAttribute('href')).split('/').at(-1);
      if (movingFile) await link('Refresh My Drive').waitFor();
      else await page.locator(`[data-focus-name="${target}"]`).and(active).waitFor();
      assert.equal(await trigger.count(), 0);
      await evidence('success');
      await openArchive.click();
      await link(name).waitFor();
      await page.goto(`${origin}/`);
      await link(movingFile ? taxes : archive).click();
      if (movingFile) await link(archive).click();
      await link(name).waitFor();
      if (movingFile) {
        const [download] = await Promise.all([page.waitForEvent('download'), link(name).press('Enter')]);
        assert.equal(download.suggestedFilename(), file.name);
        assert.deepEqual(await readFile(await download.path()), file.buffer);
      }
      assert.deepEqual(writes, [target, missing, destination].map(parentId => ({ kind: 'move', parentId })));
      await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, `keyboard-owner-move-${width}x${height}.json`), JSON.stringify({
        focus: ['path', 'close', 'cancel', 'close', 'row trigger', 'destination path', 'conflict alert', 'gone alert', 'new folder field', 'new folder path'],
        submission: [409, 404, 200], freshDestination: true, failedRefresh: movingFile, downloaded: movingFile, receipt,
      }, null, 2));
    } finally { page.off('request', track); }
  }
}
