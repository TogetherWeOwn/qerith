import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

const path = '/f/fixture-parent';
const output = process.env.DRIVE_BROWSER_EVIDENCE_DIR;
const fileName = 'Résumé 2026.pdf';

export async function captureFolderView(page, origin, db) {
  const folder = db.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES (?, ?, ?, ?, 'folder')`);
  await db.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('fixture-folder-member', 'member', 'active')").run();
  await db.batch([
    folder.bind('fixture-parent', 'fixture-owner', null, 'Receipts'),
    folder.bind('fixture-child', 'fixture-owner', 'fixture-parent', 'Child folder'),
    folder.bind('fixture-denied', 'fixture-folder-member', null, 'Private title sentinel'),
    db.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
      VALUES ('fixture-file', 'fixture-owner', 'fixture-parent', ?, 'file', 'internal-folder-key', 1)`).bind(fileName),
  ]);
  const main = page.getByRole('main');
  const visit = async suffix => {
    const response = await page.goto(origin + suffix);
    assert.equal(response.status(), 200);
    assert.equal(await response.headerValue('cache-control'), 'private, no-store');
    assert.equal(await response.headerValue('referrer-policy'), 'no-referrer');
  };
  const evidence = async (state, width, title, expected) => {
    assert.equal(await page.title(), `${title} · Drive`);
    const tree = await main.ariaSnapshot();
    for (const fragment of expected) assert(tree.includes(fragment), `${state}: ${fragment}`);
    assert.doesNotMatch(await page.content(), /internal-folder-key|fixture-filler-key-|fixture-owner|fixture-folder-member|Private title sentinel/);
    await writeFile(resolve(output, `folder-${state}-${width}-tree.txt`), tree);
    return { tree, screenshot: await capture(page, state, width, true, 'folder') };
  };
  const tab = async name => {
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    assert.deepEqual(await focused.evaluate(el => [el.textContent, getComputedStyle(el).outlineStyle]), [name, 'solid']);
    const box = await focused.boundingBox();
    assert(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height, `${name}: focus must be in view`);
  };
  const enter = async () => {
    const [response] = await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
    assert(response?.request().isNavigationRequest());
    assert.equal(response.status(), 200);
  };
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await visit(path);
    await evidence('listed', width, 'Receipts', ['heading "Receipts" [level=1]', 'list:', 'listitem:', 'link "Child folder"', 'Folder', fileName, 'File']);
    await tab('Child folder');
    await enter();
    assert.equal(new URL(page.url()).pathname, '/f/fixture-child');
    await evidence('empty', width, 'Child folder', ['heading "Child folder" [level=1]', 'heading "This folder is empty." [level=2]']);
    await visit('/f/fixture-denied');
    const denied = await evidence('denied', width, 'Folder unavailable', ['heading "This folder isn\'t available." [level=1]']);
    await visit('/f/fixture-missing');
    assert.deepEqual(await evidence('missing', width, 'Folder unavailable', [denied.tree]), denied);
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await visit(path);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, 'reflow', 320, false, 'folder');
  await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });
  await capture(page, 'greyscale', 320, false, 'folder');
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await visit(path);
  await tab('Child folder');
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  await capture(page, 'forced-colours-focus', 320, false, 'folder');
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });

  await db.prepare(`WITH RECURSIVE filler(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM filler WHERE n < 98)
    INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
    SELECT 'fixture-file-' || n, 'fixture-owner', 'fixture-parent', printf('Part %02d', n), 'file', 'fixture-filler-key-' || n, 1 FROM filler`).run();
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await folder.bind('fixture-tail', 'fixture-owner', 'fixture-parent', 'Z last').run();
    await visit(path);
    assert.equal(await main.getByRole('listitem').count(), 100);
    for (const name of ['Child folder', 'Next page']) await tab(name);
    await enter();
    assert.match(new URL(page.url()).searchParams.get('page'), /^[A-Za-z0-9_-]{378}$/);
    assert.equal(await main.getByRole('listitem').count(), 1);
    await evidence('continued', width, 'Receipts', ['link "Z last"', 'link "First page"']);
    await db.prepare("DELETE FROM drive_entries WHERE id = 'fixture-tail'").run();
    await visit(new URL(page.url()).pathname + new URL(page.url()).search);
    await evidence('end', width, 'Receipts', ['No more items.', 'link "First page"']);
    await tab('First page');
    await enter();
    assert.equal(new URL(page.url()).search, '');
    assert.equal(await main.getByRole('listitem').count(), 100);
  }
  await db.batch([
    db.prepare("DELETE FROM drive_entries WHERE parent_id = 'fixture-parent' OR id = 'fixture-denied'"),
    db.prepare("DELETE FROM drive_entries WHERE id = 'fixture-parent'"),
    db.prepare("DELETE FROM drive_principals WHERE id = 'fixture-folder-member'"),
  ]);
}
