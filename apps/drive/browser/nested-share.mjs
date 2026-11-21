import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

const parent = 'nested-share-parent', folder = 'nested-share-folder';
const parentName = 'Shared project', folderName = 'Review materials';
const memberParent = 'nested-share-member-parent', memberChild = 'nested-share-member-child', memberChildName = 'My notes';
const reader = 'Folder Reader', candidate = 'New Reader', candidateId = 'nested-share-reader';
const path = `/f/${parent}`;
const roster = id => `/api/entries/${id}/eligible-recipients`;
const grant = (id, recipient = 'member') => `/api/entries/${id}/read-grants/${recipient}`;
const cookie = value => ({ name: '__Host-drive-session', value, secure: true, httpOnly: true });

export async function proveNestedShare(browser, { origin, DB, worker, relay, ownerToken, memberToken, file, downloadPath }) {
  const fileId = downloadPath.split('/').at(-1);
  const previous = await DB.prepare('SELECT display_name FROM drive_principals WHERE id = ?').bind('member').first();
  await DB.batch([
    DB.prepare('UPDATE drive_principals SET display_name = ? WHERE id = ?').bind(reader, 'member'),
    DB.prepare("INSERT INTO drive_principals (id, role, status, display_name) VALUES (?, 'member', 'active', ?)").bind(candidateId, candidate),
    DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES
      (?1, 'owner', NULL, ?2, 'folder'), (?3, 'owner', ?1, ?4, 'folder'),
      (?5, 'member', NULL, 'My project', 'folder'), (?6, 'member', ?5, ?7, 'folder')`)
      .bind(parent, parentName, folder, folderName, memberParent, memberChild, memberChildName),
    DB.prepare('UPDATE drive_entries SET parent_id = ? WHERE id = ?').bind(parent, fileId),
  ]);
  try {
    let flag = '1', invite = true, hold;
    const target = { fetch(resource, init) {
      const headers = new Headers(init.headers);
      if (invite) headers.set('x-fixture-invite', '1');
      if (flag !== undefined) headers.set('x-fixture-read-grants', flag);
      return worker.fetch(resource, { ...init, headers });
    } };
    const ask = (pathname, token = ownerToken, method = 'GET') => target.fetch(origin + pathname, {
      method, redirect: 'manual', headers: { cookie: `${cookie(token).name}=${token}`, origin, 'sec-fetch-site': 'same-origin' },
    });
    const readback = async (id, direct) => {
      const response = await ask(roster(id));
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).recipients.find(row => row.displayName === reader),
        { recipientId: 'member', displayName: reader, direct, inheritedFrom: parentName });
    };
    assert.equal((await ask(grant(parent), ownerToken, 'PUT')).status, 204);
    for (const [width, height] of widths) {
      const isFolder = width === 1280, id = isFolder ? folder : fileId, name = isFolder ? folderName : file.name;
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      context.setDefaultTimeout(8_000);
      try {
        await context.addInitScript(() => {
          // Keep the real fetch and record aborts while the relay holds the real Worker response.
          window.shareAborts = [];
          const send = window.fetch;
          window.fetch = (input, init) => {
            if (typeof input === 'string' && input.endsWith('/eligible-recipients')) {
              init?.signal?.addEventListener('abort', () => window.shareAborts.push(input), { once: true });
            }
            return send(input, init);
          };
        });
        await context.route('**/*', async route => {
          const pending = hold;
          if (pending?.path === new URL(route.request().url()).pathname) {
            hold = undefined;
            return relay(route, target, 'same-origin', () => {
              pending.ready.resolve();
              return pending.release.promise;
            });
          }
          return relay(route, target, 'same-origin');
        });
        const page = await context.newPage(), { keyboard } = page;
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const visit = () => page.goto(origin + path, { waitUntil: 'networkidle' });
        const evidence = (state, audit = true) => capture(page, state, width, audit, 'nested-share');
        const focused = locator => locator.and(page.locator(':focus')).waitFor();
        const actions = label => page.getByRole('button', { name: `Actions for ${label}`, exact: true });
        const trigger = actions(name), menu = page.getByRole('menu');
        const dialogFor = label => page.getByRole('dialog', { name: `Share “${label}”` });
        const dialog = dialogFor(name), input = dialog.getByRole('combobox', { name: 'Add people' });
        const button = label => dialog.getByRole('button', { name: label, exact: true });
        const through = dialog.getByRole('listitem').filter({ hasText: reader });
        const remove = button('Remove Folder Reader’s direct access');
        const confirm = button('Confirm removal of direct access for Folder Reader');
        const downloadLink = page.getByRole('link', { name: file.name, exact: true });
        const responseFor = (pathname, method = 'GET') => page.waitForResponse(response =>
          response.url() === origin + pathname && response.request().method() === method);
        async function openShare(label = name) {
          await actions(label).press('ArrowDown');
          await focused(menu.getByRole('menuitem', { name: 'Share' }));
          await keyboard.press('Enter');
          await focused(dialogFor(label).getByRole('combobox', { name: 'Add people' }));
        }

        flag = '1';
        const signedOut = await visit();
        assert.equal(signedOut.status(), 401);
        assert.doesNotMatch(await signedOut.text(), /Shared project|Review materials/);
        await page.goto(`${origin}/sign-in?${new URLSearchParams({ next: path })}`, { waitUntil: 'networkidle' });
        await evidence('signed-out');
        await context.addCookies([{ ...cookie(ownerToken), url: origin }]);
        invite = false;
        assert.equal((await visit()).status(), 404);
        invite = true;
        for (const value of [undefined, 'true']) {
          flag = value;
          await visit();
          await trigger.press('ArrowDown');
          await focused(menu.getByRole('menuitem', { name: 'Move' }));
          assert.equal(await menu.getByRole('menuitem', { name: 'Share' }).count(), 0);
          await keyboard.press('Escape');
          await focused(trigger);
          assert.equal((await ask(roster(id))).status, 404);
        }

        flag = '1';
        await visit();
        await evidence('owner');
        for (const control of [page.getByRole('link', { name: folderName }), actions(folderName), downloadLink, actions(file.name)]) {
          await keyboard.press('Tab');
          await focused(control);
          assert(await control.evaluate(el => {
            const bounds = el.getBoundingClientRect();
            return getComputedStyle(el).outlineStyle === 'solid' && bounds.top >= 0 && bounds.bottom <= innerHeight;
          }));
        }
        await trigger.press('ArrowUp');
        await focused(menu.getByRole('menuitem', { name: 'Move' }));
        assert.equal(await trigger.getAttribute('aria-controls'), await menu.getAttribute('id'));
        const menuTree = await menu.ariaSnapshot();
        assert.match(menuTree, /menuitem "Share"[\s\S]*menuitem "Move"/);
        await evidence('menu');
        await keyboard.press('Enter');
        await page.getByRole('dialog', { name: `Move “${name}”` }).waitFor();
        await keyboard.press('Escape');
        await focused(trigger);
        const [inheritedRead] = await Promise.all([responseFor(roster(id)), openShare()]);
        assert.equal(inheritedRead.status(), 200);
        await through.getByText(`Through ${parentName}`).waitFor();
        assert.equal(await remove.count(), 0);
        await readback(id, false);
        await keyboard.press('Escape');
        assert.equal(await dialog.getByRole('listbox').count(), 0);
        const inheritedTree = await dialog.ariaSnapshot();
        assert.match(inheritedTree, /Folder Reader[\s\S]*Through Shared project[\s\S]*Can view/);
        assert.doesNotMatch(inheritedTree, /Remove Folder Reader/);
        await evidence('inherited');
        await input.fill(candidate);
        await dialog.getByRole('option', { name: candidate }).waitFor();
        assert.equal(await dialog.getByRole('option', { name: reader }).count(), 0);
        const pickerTree = await dialog.ariaSnapshot();
        assert.match(pickerTree, /combobox "Add people" \[expanded\][\s\S]*listbox "Available people"[\s\S]*option "New Reader"/);
        assert.match(pickerTree, /You · owner/);
        assert.equal(pickerTree.includes('anything you add to it later'), isFolder);
        await keyboard.press('Escape'); // Dismiss the picker before the dialog.
        assert.equal(await dialog.getByRole('listbox').count(), 0);
        await input.fill(candidate.slice(0, -1));
        await dialog.getByRole('option', { name: candidate }).waitFor();
        await input.press('ArrowDown');
        await input.and(page.locator('[aria-activedescendant]')).press('Enter');
        await dialog.getByRole('list', { name: 'Selected people' }).getByRole('button', { name: `Remove ${candidate}` }).waitFor();
        const submit = button('Share').and(page.locator('[aria-disabled="false"]'));
        const [granted] = await Promise.all([responseFor(grant(id, candidateId), 'PUT'), submit.press('Enter')]);
        assert.equal(granted.status(), 204);
        await dialog.getByRole('status').filter({ hasText: `Shared with ${candidate}` }).waitFor();
        await button('Remove New Reader’s access').waitFor();
        await button('Done').focus();
        await keyboard.press('Tab');
        await focused(button('Close'));
        await keyboard.press('Shift+Tab');
        await focused(button('Done'));
        await keyboard.press('Enter');
        await focused(trigger);

        // An inherited reader is excluded from the picker. Seed a direct grant through the same Worker API.
        assert.equal((await ask(grant(id), ownerToken, 'PUT')).status, 204);
        await readback(id, true);
        await openShare();
        await through.getByText(`Through ${parentName}`).waitFor();
        await remove.press('Enter');
        await dialog.getByText('They’ll still have access through this folder.', { exact: false }).waitFor();
        await readback(id, true);
        const confirmedTree = await dialog.ariaSnapshot();
        assert.match(confirmedTree, /heading "People with access"[\s\S]*button "Remove Folder Reader’s direct access" \[expanded\][\s\S]*button "Confirm removal of direct access for Folder Reader"/);
        await evidence('confirm');
        const [revoked] = await Promise.all([responseFor(grant(id), 'DELETE'), confirm.press('Enter')]);
        assert.equal(revoked.status(), 204);
        const status = dialog.getByRole('status').filter({ hasText: `Removed direct access for ${reader}.` });
        await status.waitFor();
        await focused(dialog.getByRole('heading', { name: 'People with access' }));
        assert.equal(await remove.count(), 0);
        await readback(id, false);
        await through.getByText(`Through ${parentName}`).waitFor();
        const revokedTree = await dialog.ariaSnapshot();
        assert.match(revokedTree, /status: Removed direct access for Folder Reader\.[\s\S]*Folder Reader[\s\S]*Through Shared project/);
        await evidence('revoked');
        await page.screenshot({ path: resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, `nested-share-greyscale-${width}.png`),
          style: 'dialog { filter: grayscale(1); }' });
        await page.setViewportSize({ width: 320, height });
        assert(await dialog.evaluate(el => [el, document.documentElement].every(box => box.scrollWidth <= box.clientWidth)));
        await evidence('reflow', false);
        await page.setViewportSize({ width, height });
        await page.emulateMedia({ forcedColors: 'active' });
        await button('Done').focus();
        await keyboard.press('Tab');
        await focused(button('Close'));
        assert.equal(await button('Close').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
        assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
        await evidence('forced-colours', false);
        await keyboard.press('Escape');
        await focused(trigger);
        await page.emulateMedia({ forcedColors: 'none' });

        const pending = hold = { path: roster(id), ready: Promise.withResolvers(), release: Promise.withResolvers() };
        const other = isFolder ? file.name : folderName;
        try {
          await openShare();
          await Promise.race([pending.ready.promise, page.waitForEvent('pageerror').then(error => { throw error; })]);
          const abortCount = await page.evaluate(() => window.shareAborts.length);
          await keyboard.press('Escape');
          await focused(trigger);
          await page.waitForFunction(({ count, path }) => window.shareAborts.length > count && window.shareAborts.at(-1) === path,
            { count: abortCount, path: roster(id) });
          const [otherRead] = await Promise.all([responseFor(roster(isFolder ? fileId : folder)), openShare(other)]);
          assert.equal(otherRead.status(), 200);
          pending.release.resolve();
          assert.equal(await dialog.count(), 0);
          await dialogFor(other).getByText(`Through ${parentName}`).waitFor();
          await dialogFor(other).getByRole('button', { name: 'Done', exact: true }).press('Enter');
          await focused(actions(other));
        } finally { pending.release.resolve(); }

        await context.addCookies([{ ...cookie(memberToken), url: origin }]);
        assert.equal((await visit()).status(), 200);
        await page.getByRole('link', { name: folderName }).waitFor();
        assert.equal(await page.getByRole('button', { name: /^Actions for / }).count(), 0);
        for (const entry of [fileId, folder]) {
          assert.equal((await ask(roster(entry), memberToken)).status, 404);
          assert.equal((await ask(grant(entry, candidateId), memberToken, 'PUT')).status, 404);
          assert.equal((await ask(grant(entry, candidateId), memberToken, 'DELETE')).status, 404);
        }
        assert.equal(await downloadLink.getAttribute('href'), downloadPath);
        const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.press('Enter')]);
        assert.equal(download.suggestedFilename(), file.name);
        assert.deepEqual(await readFile(await download.path()), file.buffer);
        await evidence('read-only');
        assert.equal((await page.goto(`${origin}/f/${memberParent}`)).status(), 200);
        const [memberRead] = await Promise.all([responseFor(roster(memberChild)), openShare(memberChildName)]);
        assert.equal(memberRead.status(), 200);
        await dialogFor(memberChildName).getByRole('option', { name: candidate }).waitFor();
        await context.addCookies([{ ...cookie(ownerToken), url: origin }]);
        await visit();
        assert.equal((await ask(grant(id), ownerToken, 'PUT')).status, 204);
        await openShare();
        await remove.press('Enter');
        // The ancestor grant disappears while the direct-revoke confirmation is open.
        assert.equal((await ask(grant(parent), ownerToken, 'DELETE')).status, 204);
        const [raceRevoke, freshRoster] = await Promise.all([
          responseFor(grant(id), 'DELETE'), responseFor(roster(id)), confirm.press('Enter'),
        ]);
        assert.deepEqual([raceRevoke.status(), freshRoster.status()], [204, 200]);
        assert.deepEqual((await freshRoster.json()).recipients.find(row => row.displayName === reader),
          { recipientId: 'member', displayName: reader, direct: false, inheritedFrom: null });
        const raceStatus = dialog.getByRole('status').filter({ hasText: `Removed direct access for ${reader}.` });
        await raceStatus.waitFor();
        assert.doesNotMatch(await raceStatus.textContent(), /Access through/);
        await through.waitFor({ state: 'hidden' });
        assert.equal((await ask(grant(parent), ownerToken, 'PUT')).status, 204);
        assert.deepEqual(errors, []);
        assert(![inheritedTree, pickerTree, confirmedTree, revokedTree].some(tree => tree.includes(candidateId) || tree.includes(id)));
        await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, `nested-share-aria-review-${width}.txt`), [
          'RowActions exposes the named menu and Share and Move menu items. The trigger’s aria-controls references the open menu.',
          'ShareDialog names the entry and exposes the owner, access heading, folder-derived access, and the confirmation controls for direct access.',
          'ShareRecipientPicker exposes the labelled combobox and listbox. A reader who already has inherited access is absent from the choices.',
          'The status region announces that direct access was removed. The refreshed list describes access through the folder. Focus returns to the access heading and then the originating row.',
          menuTree, inheritedTree, pickerTree, confirmedTree, revokedTree,
        ].join('\n\n'));
      } finally { await context.close(); }
    }
  } finally {
    await DB.batch([
      DB.prepare('UPDATE drive_entries SET parent_id = NULL WHERE id = ?').bind(fileId),
      DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(folder),
      DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(parent),
      DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(memberChild),
      DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(memberParent),
      DB.prepare('UPDATE drive_principals SET display_name = ? WHERE id = ?').bind(previous.display_name, 'member'),
      DB.prepare('DELETE FROM drive_principals WHERE id = ?').bind(candidateId),
    ]);
  }
  console.log('Generated Worker nested Share: exact gate, inherited and direct access, confirmed revoke, read-only download, keyboard and axe passed');
}
