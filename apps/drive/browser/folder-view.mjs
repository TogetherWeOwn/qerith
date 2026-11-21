import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

const path = '/f/fixture-parent';
const output = process.env.DRIVE_BROWSER_EVIDENCE_DIR;
const fileName = 'Résumé 2026.pdf';

export async function captureFolderView(page, origin, db, { owner = 'fixture-owner', scope = 'folder' } = {}) {
  await db.batch([
    db.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('fixture-folder-member', 'member', 'active')"),
    db.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES
      ('fixture-child', ?1, 'fixture-parent', 'Child folder', 'folder', NULL, NULL),
      ('legacy:receipts', ?1, 'fixture-parent', 'Imported folder', 'folder', NULL, NULL),
      ('fixture-denied', 'fixture-folder-member', NULL, 'Private title sentinel', 'folder', NULL, NULL),
      ('fixture-file', ?1, 'fixture-parent', ?2, 'file', 'internal-folder-key', 1)`).bind(owner, fileName),
  ]);
  const main = page.getByRole('main');
  const visit = async suffix => {
    const response = await page.goto(origin + suffix);
    const headers = response.headers();
    assert.deepEqual([response.status(), headers['cache-control'], headers['referrer-policy']], [200, 'private, no-store', 'no-referrer']);
  };
  const evidence = async (state, width, title, expected, suffix) => {
    if (suffix) await visit(suffix);
    assert.equal(await page.title(), `${title} · Drive`);
    const tree = await main.ariaSnapshot();
    for (const fragment of expected) assert(tree.includes(fragment), `${state}: ${fragment}`);
    assert.doesNotMatch(await page.content(), /internal-folder-key|fixture-filler-key-|fixture-owner|fixture-folder-member|Private title sentinel/);
    await writeFile(resolve(output, `${scope}-${state}-${width}-tree.txt`), tree);
    await capture(page, state, width, true, scope);
    return tree;
  };
  const tab = async name => {
    await page.keyboard.press('Tab');
    assert.deepEqual(await page.locator(':focus').evaluate(el => {
      const { top, bottom } = el.getBoundingClientRect();
      return [el.textContent, getComputedStyle(el).outlineStyle, top >= 0 && bottom <= innerHeight];
    }), [name, 'solid', true]);
  };
  const activate = async name => {
    if (scope === 'staging-folder' && name === 'Next page') await main.getByRole('link', { name, exact: true }).focus();
    else await tab(name);
    const [response] = await Promise.all([page.waitForNavigation(), page.keyboard.press('Enter')]);
    assert.equal(response?.status(), 200, `${name}: full document navigation`);
  };
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await evidence('listed', width, 'Receipts', ['heading "Receipts" [level=1]', 'list:', 'listitem:', 'link "Child folder"', 'Imported folder', 'Folder', fileName, 'File'], path);
    assert.equal(await main.getByRole('link', { name: 'Imported folder' }).count(), 0);
    await activate('Child folder');
    await evidence('empty', width, 'Child folder', ['heading "Child folder" [level=1]', 'heading "This folder is empty." [level=2]']);
    const denied = await evidence('denied', width, 'Folder unavailable', ['heading "This folder isn\'t available." [level=1]', "It may have been deleted or moved, or it isn't shared with you.", 'link "Go to My Drive"'], '/f/fixture-denied');
    assert.equal(await evidence('missing', width, 'Folder unavailable', [], '/f/fixture-missing'), denied);
    const screenshot = state => readFile(resolve(output, `${scope}-${state}-${width}.png`));
    assert.deepEqual(await screenshot('missing'), await screenshot('denied'));
    await activate('Go to My Drive');
    assert.equal(new URL(page.url()).pathname, '/');
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await visit(path);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await capture(page, 'reflow', 320, false, scope);
  await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });
  await capture(page, 'greyscale', 320, false, scope);
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  await visit(path);
  await tab('Child folder');
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  await capture(page, 'forced-colours-focus', 320, false, scope);
  await page.emulateMedia({ reducedMotion: null, forcedColors: null });

  await db.prepare(`WITH RECURSIVE filler(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM filler WHERE n < 97)
    INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
    SELECT 'fixture-file-' || n, ?, 'fixture-parent', printf('Part %02d', n), 'file', 'fixture-filler-key-' || n, 1 FROM filler`).bind(owner).run();
  for (const [width, height] of widths) {
    await page.setViewportSize({ width, height });
    await db.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES ('fixture-tail', ?, 'fixture-parent', 'Z last', 'folder')").bind(owner).run();
    await visit(path);
    assert.equal(await main.getByRole('listitem').count(), 100);
    await tab('Child folder');
    await activate('Next page');
    assert.match(new URL(page.url()).searchParams.get('page'), /^[A-Za-z0-9_-]{378}$/);
    assert.equal(await main.getByRole('listitem').count(), 1);
    await evidence('continued', width, 'Receipts', ['link "Z last"', 'link "First page"']);
    await db.prepare("DELETE FROM drive_entries WHERE id = 'fixture-tail'").run();
    await evidence('end', width, 'Receipts', ['No more items.', 'link "First page"'], path + new URL(page.url()).search);
    await activate('First page');
    assert.equal(new URL(page.url()).search, '');
    await writeFile(resolve(output, `${scope}-keyboard-${width}.json`), JSON.stringify({ viewport: [width, height],
      visibleTabFocus: true, enterDocumentNavigation: ['Child folder', 'Go to My Drive', 'Next page', 'First page'] }));
  }
  await db.prepare("DELETE FROM drive_entries WHERE parent_id = 'fixture-parent' OR id IN ('fixture-parent', 'fixture-denied')").run();
  await db.prepare("DELETE FROM drive_principals WHERE id = 'fixture-folder-member'").run();
}
