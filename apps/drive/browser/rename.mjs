import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function proveRename(page, { origin, DB, principal, intercept, cursor }) {
  const role = intercept ? 'owner' : 'member';
  const file = crypto.randomUUID(), folder = `rename/${role}'folder`;
  const starting = 'Taxes 2025.pdf', stored = 'Taxes \n2025.pdf', taken = 'Taken.pdf';
  const location = `${origin}/${cursor ? `?page=${cursor}` : ''}`;
  const path = id => `/api/entries/${encodeURIComponent(id).replaceAll("'", '%27')}`;
  const state = id => DB.prepare('SELECT name, parent_id FROM drive_entries WHERE id = ?').bind(id).first();
  await DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes)
    VALUES (?, ?, ?, 'file', ?, 1), (?, ?, ?, 'file', ?, 1)`)
    .bind(file, principal, stored, file, `${file}-taken`, principal, taken, `${file}-taken`).run();
  await DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, 'Folder 095.me', 'folder')`).bind(folder, principal).run();
  const isPatch = r => r.method() === 'PATCH' && r.url().startsWith(`${origin}/api/entries/`);
  const writes = [];
  const track = request => { if (isPatch(request)) writes.push([new URL(request.url()).pathname, request.postDataJSON()]); };
  page.on('request', track);
  const trigger = name => page.getByRole('button', { name: `Actions for ${name}`, exact: true });
  const dialog = page.getByRole('dialog', { name: /^Rename / });
  const field = dialog.getByRole('textbox', { name: 'Name', exact: true });
  const conflict = dialog.getByRole('alert').filter({ hasText: `The name "${taken}" is already in use.` });
  const active = page.locator(':focus');
  const open = async (name, selected = name) => {
    await trigger(name).press('ArrowDown');
    const item = page.getByRole('menuitem', { name: 'Rename' });
    await item.and(active).waitFor();
    await item.press('Enter');
    await field.and(active).waitFor();
    assert.equal(await field.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), selected);
  };
  const submit = async (name, id, status, typeBasename = false) => {
    if (typeBasename) await page.keyboard.insertText(name.slice(0, -4));
    else await field.fill(name);
    const [response] = await Promise.all([page.waitForResponse(r => isPatch(r.request())), field.press('Enter')]);
    assert.deepEqual([response.status(), writes.at(-1)], [status, [path(id), { kind: 'rename', name }]]);
  };
  const keyboard = {};
  try {
    for (const [width, height] of widths) {
      const evidence = stage => capture(page, stage, width, true, `${role}-rename`);
      await page.setViewportSize({ width, height });
      await page.goto(location, { waitUntil: 'networkidle' });
      await open(starting, 'Taxes 2025');
      keyboard[width] = await dialog.ariaSnapshot();
      assert.match(keyboard[width], /textbox "Name": Taxes 2025\.pdf/);
      await evidence('open');
      const before = writes.length;
      for (const [key, label] of [['Shift+Tab', 'Close'], ['Shift+Tab', 'Cancel'], ['Tab', 'Close']]) {
        await page.keyboard.press(key);
        await dialog.getByRole('button', { name: label, exact: true }).and(active).waitFor();
      }
      await page.keyboard.press('Escape');
      await trigger(starting).and(active).waitFor();
      await open(starting, 'Taxes 2025');
      await field.press('Enter');
      await trigger(starting).and(active).waitFor();
      assert.equal(writes.length, before, 'Cancel and unchanged submit never write');
      await open(starting, 'Taxes 2025');
      await field.fill('');
      await field.press('Enter');
      await dialog.getByRole('alert').filter({ hasText: 'Type a name.' }).waitFor();
      await field.fill('📁'.repeat(64));
      await dialog.getByRole('alert').filter({ hasText: 'That name is too long.' }).waitFor();
      assert.equal(writes.length, before, 'invalid names never write');
      await submit(taken, file, 409);
      await Promise.all([conflict.waitFor(), field.and(active).waitFor()]);
      assert.equal(await field.inputValue(), taken);
      await evidence('duplicate');
      if (intercept) {
        intercept(path(file), route => route.fulfill({ status: 503 }));
        await submit('Unconfirmed.pdf', file, 503);
        await dialog.getByRole('alert').filter({ hasText: 'We couldn’t confirm the rename.' }).and(active).waitFor();
        assert.equal(await field.inputValue(), 'Unconfirmed.pdf');
        await evidence('failure');
        assert.equal(writes.length, before + 2, 'no automatic retry');
        assert.deepEqual(await state(file), { name: stored, parent_id: null });
        await page.keyboard.press('Escape');
        await open(starting, 'Taxes 2025');
      }
      const held = Promise.withResolvers();
      intercept?.(path(file), async (_, relay) => { await held.promise; return relay(); });
      const renamed = `Taxes ${width} 📁.pdf`;
      const saved = submit(renamed, file, 200, !!intercept);
      try {
        if (intercept) {
          const pending = dialog.getByRole('button', { name: 'Renaming…' });
          assert.equal(await pending.getAttribute('aria-busy'), 'true');
          assert.equal(await field.getAttribute('readonly'), '');
          await page.keyboard.press('Escape');
          await field.press('Enter');
          await evidence('pending');
        }
      } finally { held.resolve(); }
      await saved;
      await trigger(renamed).and(active).waitFor();
      await page.getByRole('status').filter({ hasText: `Renamed to “${renamed}”.` }).waitFor();
      assert.equal(writes.length, before + (intercept ? 3 : 2), 'one write per explicit attempt');
      assert.equal(page.url(), location);
      assert.deepEqual(await state(file), { name: renamed, parent_id: null });
      await evidence('success');
      if (intercept) {
        await open(renamed, `Taxes ${width} 📁`);
        const read = Promise.withResolvers();
        intercept('/__data.json', async route => { await read.promise; await route.abort(); });
        const recovery = page.getByRole('link', { name: 'Refresh My Drive', exact: true });
        try {
          await submit('Refresh needed.pdf', file, 200);
          await recovery.and(active).waitFor({ timeout: 8_000 });
        } finally { read.resolve(); }
        await page.getByRole('status').filter({ hasText: 'Renamed to “Refresh needed.pdf”. Refresh My Drive to see it.' }).waitFor();
        await evidence('refresh-failed');
        await open(renamed, `Taxes ${width} 📁`);
        await page.keyboard.press('Escape');
        await Promise.all([page.waitForEvent('framenavigated'), recovery.press('Enter')]);
        await page.waitForLoadState('networkidle');
        await trigger('Refresh needed.pdf').waitFor();
        assert.equal(page.url(), location);
        assert.equal(writes.length, before + 4, 'recovery only reads');
      }
      await DB.prepare('UPDATE drive_entries SET name = ? WHERE id = ?').bind(stored, file).run();
    }
    if (intercept) {
      await page.reload({ waitUntil: 'networkidle' });
      await open('Folder 095.me');
      await submit('A Renamed folder', folder, 200); // Sorts before the current cursor.
      const neighbor = page.locator('[data-focus-name]').filter({ hasText: /^Folder 096$/ }).and(active);
      for (const [width, height] of [widths.at(-1), ...widths]) {
        await page.setViewportSize({ width, height });
        await neighbor.and(page.locator(width > 820 ? 'table :focus' : 'ul :focus')).waitFor();
      }
      await open(starting, 'Taxes 2025');
      const before = writes.length;
      await field.fill(''); // Explicitly retype the displayed name, removing the stored line break.
      await submit(starting, file, 200);
      await trigger(starting).and(active).waitFor();
      assert.equal(writes.length, before + 1);
      assert.deepEqual(await state(file), { name: starting, parent_id: null });
      await open(starting, 'Taxes 2025');
      await DB.prepare('UPDATE drive_entries SET parent_id = ? WHERE id = ?').bind(folder, file).run();
      await DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES (?, ?, ?, ?, 'folder')")
        .bind(`${folder}-taken`, principal, folder, taken).run();
      await submit(taken, file, 409);
      await conflict.waitFor();
      await submit('Moved elsewhere.pdf', file, 200);
      assert.deepEqual(await state(file), { name: 'Moved elsewhere.pdf', parent_id: folder });
      await page.getByRole('status').filter({ hasText: 'Renamed to “Moved elsewhere.pdf”. It isn’t on this page.' }).waitFor();
    }
    await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, `${role}-rename-accessibility.json`), JSON.stringify({
      viewports: widths, snapshots: keyboard, writes,
      evidence: 'Chromium accessibility tree and keyboard focus assertions; no native screen reader used',
    }, null, 2));
  } finally { page.off('request', track); }
}
