import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function proveMove(page, { origin, DB, intercept }) {
  const name = '! Move A source', taxes = '! Move B Taxes', deleted = '! Move C Deleted';
  const folder = (id, label, parent = null) => DB.prepare(`INSERT INTO drive_entries
    (id, owner_id, parent_id, name, kind) VALUES (?, 'owner', ?, ?, 'folder')`).bind(id, parent, label).run();
  const remove = id => DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(id).run();
  const active = page.locator(':focus');
  for (const [width, height] of widths) {
    const source = `move-source-${width}`, target = `move-taxes-${width}`, missing = `move-deleted-${width}`;
    await folder(source, name);
    await folder(`${source}-child`, 'Keep with source', source);
    await folder(target, taxes);
    await folder(`${target}-duplicate`, name, target);
    await folder(missing, deleted);
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
    const trigger = page.getByRole('button', { name: `Actions for ${name}`, exact: true });
    const dialog = page.getByRole('dialog', { name: /^Move “/ });
    const button = label => dialog.getByRole('button', { name: label, exact: true });
    const heading = label => dialog.getByRole('heading', { name: label, exact: true });
    const evidence = state => capture(page, state, width, true, 'owner-move');
    const open = async () => {
      await trigger.press('ArrowDown');
      await page.getByRole('menuitem', { name: 'Move', exact: true }).press('Enter');
      await button(taxes).waitFor();
    };
    const path = `/api/entries/${source}`;
    const writes = [];
    const matches = request => request.method() === 'PATCH' && new URL(request.url()).pathname === path;
    const track = request => { if (matches(request)) writes.push(request.postDataJSON()); };
    const submit = label => Promise.all([page.waitForResponse(r => matches(r.request())), button(label).press('Enter')]);
    page.on('request', track);
    try {
      await open();
      await heading('My Drive').and(active).waitFor();
      await page.keyboard.press('Shift+Tab');
      await button('Close').and(active).waitFor();
      await page.keyboard.press('Shift+Tab');
      await button('Cancel').and(active).waitFor();
      await page.keyboard.press('Tab');
      await button('Close').and(active).waitFor();
      assert.equal(await button(name).getAttribute('aria-disabled'), 'true');
      assert.equal(await button('Move to My Drive').getAttribute('aria-disabled'), 'true');
      await button(name).press('Enter');
      await button('Move to My Drive').press('Enter');
      assert.equal(writes.length, 0);
      await evidence('open');
      await page.keyboard.press('Escape');
      await trigger.and(active).waitFor();
      await open();
      await button(taxes).press('Space');
      await heading(`My Drive / ${taxes}`).and(active).waitFor();
      assert.equal((await submit(`Move to ${taxes}`))[0].status(), 409);
      await dialog.getByRole('alert').and(active).waitFor();
      await evidence('conflict');
      await button('Up to My Drive').press('Enter');
      await heading('My Drive').and(active).waitFor();
      await button(deleted).press('Enter');
      await heading(`My Drive / ${deleted}`).and(active).waitFor();
      await remove(missing);
      assert.equal((await submit(`Move to ${deleted}`))[0].status(), 404);
      await dialog.getByRole('alert').filter({ hasText: 'Pick another one.' }).and(active).waitFor();
      assert.equal(await button(`Move to ${deleted}`).getAttribute('aria-disabled'), 'true');
      await evidence('gone');
      await button('Up to My Drive').press('Enter');
      await button(taxes).press('Enter');
      await heading(`My Drive / ${taxes}`).and(active).waitFor();
      await button('New folder').press('Enter');
      const create = page.getByRole('dialog', { name: `New folder in ${taxes}` });
      const input = create.getByRole('textbox', { name: 'Folder name' });
      await input.and(active).fill('Archive');
      await input.press('Enter');
      await heading(`My Drive / ${taxes} / Archive`).and(active).waitFor();
      const hold = Promise.withResolvers();
      intercept(path, async (_, relay) => { await hold.promise; return relay(); });
      const pending = submit('Move to Archive');
      try {
        await button('Moving…').waitFor();
        assert.equal(await button('Moving…').getAttribute('aria-busy'), 'true');
        await page.keyboard.press('Escape');
        await dialog.waitFor();
        await evidence('saving');
      } finally { hold.resolve(); }
      assert.equal((await pending)[0].status(), 200);
      await dialog.waitFor({ state: 'hidden' });
      const status = page.getByRole('status').filter({ hasText: 'Moved to Archive' });
      const link = page.getByRole('link', { name: 'Open Archive', exact: true });
      await status.waitFor();
      const archive = (await link.getAttribute('href')).split('/').at(-1);
      assert.deepEqual(writes, [target, missing, archive].map(parentId => ({ kind: 'move', parentId })));
      await page.locator('[data-focus-name]').filter({ hasText: taxes }).and(active).waitFor();
      assert.equal(await trigger.count(), 0);
      await evidence('success');
      await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, `keyboard-owner-move-${width}x${height}.json`), JSON.stringify({
        focus: ['path', 'close', 'cancel', 'close', 'row trigger', 'destination path', 'conflict alert', 'parent path', 'gone alert', 'new folder field', 'new folder path', 'next row name'],
        submission: ['self and current disabled', 409, 404, 200], design: 'cd948bdd116740f2cc0df58d22afd40449f79307',
      }, null, 2));
      await link.click();
      await page.getByRole('heading', { name: 'Archive', exact: true }).waitFor();
      await page.getByRole('link', { name, exact: true }).waitFor();
      for (const id of [`${source}-child`, source, `${target}-duplicate`, archive, target]) await remove(id);
    } finally { page.off('request', track); }
  }
}
