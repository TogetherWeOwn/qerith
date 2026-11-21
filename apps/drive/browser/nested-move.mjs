import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';
export async function proveNestedMove(page, origin, db, intercept) {
  for (const [width, height] of widths) {
    console.log(`Nested Move (${width}×${height})`);
    const parent = `nested-parent-${width}`, source = `nested-source-${width}`, path = `/f/${parent}`;
    const name = '01 Résumé', destination = `! Nested destination ${width}`, removed = `! Nested removed ${width}`, home = `! Nested source ${width}`;
    const nested = width === 1280, target = nested ? destination : 'My Drive', primary = `Move to ${target}`;
    const seed = rows => db.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES ${rows}`);
    const seedSourceFolder = () => seed(`(?1, 'owner', NULL, ?2, 'folder'), (?1 || '-next', 'owner', ?1, '02 Next', 'folder'),
      (?1 || '-other', 'owner', ?1, '03 Other', 'folder')`).bind(parent, home).run();
    await seedSourceFolder();
    await seed(`(?2, 'owner', ?1, ?3, 'folder'), (?2 || '-child', 'owner', ?2, 'Descendant', 'folder'),
      ('nested-target', 'owner', NULL, ?4, 'folder'), ('nested-clash', 'owner', 'nested-target', ?3, 'folder'),
      ('nested-gone', 'owner', NULL, ?5, 'folder')`).bind(parent, source, name, destination, removed).run();
    await page.setViewportSize({ width, height });
    await page.goto(origin + path);
    const actions = item => page.getByRole('button', { name: `Actions for ${item}` }), trigger = actions(name);
    const dialog = page.getByRole('dialog', { name: /^Move “/ });
    const button = name => dialog.getByRole('button', { name, exact: true });
    const focused = page.locator(':focus'), evidence = state => capture(page, state, width, true, 'nested-move');
    const next = page.getByRole('link', { name: '02 Next' }).and(focused);
    const status = text => page.getByRole('status').filter({ hasText: text }), generic = status(/^Item moved\.$/);
    const open = async (item = name) => {
      await actions(item).press('ArrowDown');
      await page.getByRole('menuitem', { name: 'Move' }).press('Enter');
    };
    const patch = `/api/entries/${source}`, secondPatch = `/api/entries/${parent}-other`, requests = [];
    const writes = r => r.method() === 'PATCH' && [patch, secondPatch].includes(new URL(r.url()).pathname);
    const track = r => { if (writes(r) || r.url().startsWith(`${origin}${path}/__data.json`)) requests.push(r.url()); };
    page.on('request', track);
    const submit = async label => (await Promise.all([page.waitForResponse(r => writes(r.request())), button(label).press('Enter', { noWaitAfter: true })]))[0].status();
    if (nested) {
      const reparent = id => db.prepare('UPDATE drive_entries SET parent_id = ? WHERE id = ?').bind(id, source).run();
      await reparent('nested-gone'); await open();
      await dialog.getByRole('alert').filter({ hasText: 'Refresh this folder' }).and(focused).waitFor();
      assert.equal(await button('Move to My Drive').getAttribute('aria-disabled'), 'true');
      await button('Move to My Drive').press('Enter');
      await page.keyboard.press('Escape'); await trigger.and(focused).waitFor();
      await reparent(parent); // The PATCH trace also proves the stale picker never wrote.
    }
    await open();
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
    await evidence('gone'); await button('Up to My Drive').press('Enter');
    const held = Promise.withResolvers(), reloadGate = Promise.withResolvers();
    if (nested) {
      await button(target).press('Enter');
      intercept(patch, route => route.abort());
      await button(primary).press('Enter');
      assert.match(await dialog.getByRole('alert').and(focused).textContent(), /Refresh the source folder and check the selected destination/);
      assert.equal(await button(primary).getAttribute('aria-disabled'), 'true');
      await button(primary).press('Enter');
      await page.reload(); await open(); await button(target).press('Enter');
      await db.prepare("DELETE FROM drive_entries WHERE id = 'nested-clash'").run();
      intercept(path, (_, forward) => reloadGate.promise.then(() => db.prepare("DELETE FROM drive_entries WHERE id IN (?1, ?1 || '-next', ?1 || '-other')")
        .bind(parent).run()).then(() => forward()));
    }
    const isReload = r => r.url() === origin + path && r.isNavigationRequest();
    const started = page.waitForRequest(isReload), reload = page.waitForResponse(r => isReload(r.request()));
    intercept(patch, async (_, forward) => { await held.promise; return forward(); });
    const pending = submit(primary);
    try {
      await button('Moving…').waitFor(); await page.keyboard.press('Escape');
      await evidence('saving');
    } finally { held.resolve(); }
    try {
      assert.equal(await pending, 200);
      if (nested) await Promise.all([started, dialog.waitFor({ state: 'hidden' }), next.waitFor(), generic.waitFor(),
        page.locator(`[data-row="${source}"]`).waitFor({ state: 'detached' })]);
    } finally { reloadGate.resolve(); }
    assert.equal((await reload).status(), 200);
    if (nested) {
      console.log('Nested Move: checking unavailable-document and receipt recovery');
      await page.getByRole('heading', { name: "This folder isn't available." }).and(focused).waitFor();
      await status('Item moved. Refresh this page').waitFor();
      const api = '/api/move-destinations', lookup = id => r => r.url().startsWith(`${origin}${api}?entry=${id}&`);
      intercept(api, () => {}); // Interrupt verification with another document reload.
      await seedSourceFolder(); await Promise.all([page.waitForRequest(lookup(source)), page.reload()]);
      await generic.waitFor();
      console.log('Nested Move: refreshing again and checking the superseding receipt');
      const deliver = Promise.withResolvers(), load = Promise.withResolvers();
      intercept(api, (_, forward) => forward(true, () => deliver.promise));
      await Promise.all([page.waitForRequest(lookup(source)), page.reload()]);
      await page.evaluate(entry => {
        const json = Response.prototype.json;
        Response.prototype.json = async function () {
          const body = await json.call(this);
          if (this.url.includes(`entry=${entry}&`)) setTimeout(() => performance.mark('first-receipt-processed'), 0);
          return body;
        };
      }, source);
      try {
        await open('03 Other'); await button(target).press('Enter');
        intercept(path, (_, forward) => forward(true, () => load.promise));
        const secondReload = page.waitForRequest(isReload);
        assert.equal(await submit(primary), 200); await secondReload;
        deliver.resolve();
        await page.waitForFunction(() => performance.getEntriesByName('first-receipt-processed').length);
        assert.equal(await generic.count(), 1, 'the older result cannot replace the second receipt before reload');
        const secondReceipt = page.waitForRequest(lookup(`${parent}-other`));
        load.resolve(); await secondReceipt;
      } finally { deliver.resolve(); load.resolve(); }
    }
    await next.waitFor(); await status(`Moved to ${target}`).waitFor();
    assert.equal(await trigger.count(), 0);
    await evidence('success');
    await page.getByRole('link', { name: `Open ${target}` }).press('Enter');
    for (const item of nested ? [name, '03 Other'] : [name]) await page.getByRole('list').getByRole('link', { name: item, exact: true }).waitFor();
    await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, `keyboard-nested-move-${width}x${height}.json`),
      JSON.stringify({ focus: ['trigger', 'current path', 'conflict alert', 'gone alert', ...(nested ? ['unconfirmed alert'] : []), 'next row'],
        submission: nested ? [409, 404, 'aborted', 200, 200] : [409, 404, 200], documentReload: true, destination: target, unavailableReload: nested }));
    page.off('request', track);
    assert.deepEqual(requests, [...Array(nested ? 4 : 3).fill(origin + patch), ...(nested ? [origin + secondPatch] : [])]);
    await db.prepare("DELETE FROM drive_entries WHERE id IN (?, ?, ?, 'nested-clash', 'nested-target')").bind(source, `${source}-child`, `${parent}-other`).run();
  }
}
