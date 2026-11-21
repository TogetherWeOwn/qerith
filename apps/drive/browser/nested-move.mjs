import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function proveNestedMove(page, origin, db, intercept) {
  for (const [width, height] of widths) {
    const parent = `nested-parent-${width}`, source = `nested-source-${width}`, path = `/f/${parent}`;
    const name = '01 Résumé', destination = `! Nested destination ${width}`, removed = `! Nested removed ${width}`, home = `! Nested source ${width}`;
    await db.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES
      (?1, 'owner', NULL, ?3, 'folder'), (?2, 'owner', ?1, ?4, 'folder'),
      (?2 || '-child', 'owner', ?2, 'Descendant', 'folder'), (?1 || '-next', 'owner', ?1, '02 Next', 'folder'),
      ('nested-target', 'owner', NULL, ?5, 'folder'), ('nested-clash', 'owner', 'nested-target', ?4, 'folder'),
      ('nested-gone', 'owner', NULL, ?6, 'folder')`).bind(parent, source, home, name, destination, removed).run();
    await page.setViewportSize({ width, height });
    await page.goto(origin + path);
    const trigger = page.getByRole('button', { name: `Actions for ${name}` });
    const dialog = page.getByRole('dialog', { name: /^Move “/ });
    const button = name => dialog.getByRole('button', { name, exact: true });
    const focused = page.locator(':focus');
    const evidence = state => capture(page, state, width, true, 'nested-move');
    const open = async () => {
      await trigger.press('ArrowDown');
      await page.getByRole('menuitem', { name: 'Move' }).press('Enter');
      await button(home).waitFor();
    };
    const patch = `/api/entries/${source}`, requests = [];
    const writes = r => r.method() === 'PATCH' && new URL(r.url()).pathname === patch;
    const track = r => { if (writes(r) || r.url().startsWith(`${origin}${path}/__data.json`)) requests.push(r.url()); };
    page.on('request', track);
    const submit = async label => (await Promise.all([page.waitForResponse(r => writes(r.request())), button(label).press('Enter')]))[0].status();
    await open(); await page.keyboard.press('Escape');
    await trigger.and(focused).waitFor(); await open();
    await button(home).press('Enter');
    await dialog.getByRole('heading', { name: `My Drive / ${home}` }).and(focused).waitFor();
    for (const label of [name, `Move to ${home}`]) assert.equal(await button(label).getAttribute('aria-disabled'), 'true');
    await evidence('current-and-self');
    await button('Up to My Drive').press('Enter');
    await button(destination).press('Enter');
    assert.equal(await submit(`Move to ${destination}`), 409);
    await dialog.getByRole('alert').and(focused).waitFor(); await evidence('conflict');
    await button('Up to My Drive').press('Enter');
    await button(removed).press('Enter');
    await dialog.getByRole('heading', { name: `My Drive / ${removed}` }).and(focused).waitFor();
    await db.prepare("DELETE FROM drive_entries WHERE id = 'nested-gone'").run();
    assert.equal(await submit(`Move to ${removed}`), 404);
    await dialog.getByRole('alert').and(focused).waitFor();
    assert.equal(await button(`Move to ${removed}`).getAttribute('aria-disabled'), 'true');
    await evidence('gone');
    await button('Up to My Drive').press('Enter');
    const reload = page.waitForResponse(r => r.url() === origin + path && r.request().isNavigationRequest());
    const held = Promise.withResolvers();
    intercept(patch, async (_, forward) => { await held.promise; return forward(); });
    const pending = submit('Move to My Drive');
    try {
      await button('Moving…').waitFor();
      await page.keyboard.press('Escape');
      await evidence('saving');
    } finally { held.resolve(); }
    assert.equal(await pending, 200);
    assert.equal((await reload).status(), 200);
    await page.getByRole('link', { name: '02 Next' }).and(focused).waitFor();
    await page.getByRole('status').filter({ hasText: 'Moved to My Drive' }).waitFor();
    assert.equal(await trigger.count(), 0);
    await evidence('success');
    await page.getByRole('link', { name: 'Open My Drive' }).press('Enter');
    await page.getByRole('link', { name, exact: true }).waitFor();
    await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, `keyboard-nested-move-${width}x${height}.json`),
      JSON.stringify({ focus: ['trigger', 'current path', 'conflict alert', 'gone alert', 'next row'], submission: [409, 404, 200], documentReload: true }));
    page.off('request', track);
    assert.deepEqual(requests, Array(3).fill(origin + patch));
    await db.prepare("DELETE FROM drive_entries WHERE id IN (?, ?, 'nested-clash', 'nested-target')").bind(source, `${source}-child`).run();
  }
}
