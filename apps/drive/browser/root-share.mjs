import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture } from './root-listing.mjs';

const folder = 'share / folder', file = 'share-root-file', child = 'share-child', owned = 'share-member-folder';
const reader = 'share-reader-000', second = 'share-reader-001', third = 'share-reader-002';
const late = 'share-reader-101';
const folderName = 'Shareable folder', fileName = 'Shareable file', memberName = 'Member’s own folder';
const entry = id => `/api/entries/${encodeURIComponent(id)}`;
const roster = id => `${entry(id)}/eligible-recipients`;
const grant = (id, recipient) => `${entry(id)}/read-grants/${recipient}`;
const cookie = value => ({ name: '__Host-drive-session', value, secure: true, httpOnly: true });

export async function proveRootShare(browser, { origin, DB, worker, relay, ownerToken, memberToken }) {
  const names = ['Root Reader', 'Second Reader', 'Third Reader'];
  const session = await DB.prepare("SELECT token_hash, expires_at FROM drive_sessions WHERE principal_id = 'member'").first();
  const recipients = Array.from({ length: 102 }, (_, i) => DB.prepare(
    "INSERT INTO drive_principals (id, role, status, display_name) VALUES (?, 'member', 'active', ?)"
  ).bind(`share-reader-${String(i).padStart(3, '0')}`, names[i] ?? `Roster Person ${i}`));
  const insertFolder = (id, owner, name, parent = null) => DB.prepare(
    "INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES (?, ?, ?, ?, 'folder')"
  ).bind(id, owner, parent, name);
  await DB.batch([
    ...recipients, insertFolder(folder, 'owner', folderName), insertFolder(child, 'owner', 'Nested folder', folder),
    insertFolder(owned, 'member', memberName),
    DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes) VALUES (?, 'owner', ?, 'file', ?, 0)")
      .bind(file, fileName, file),
  ]);
  let flag = '1', ownerInvites = false, failRead = false, writes = [];
  const target = { async fetch(resource, init) {
    const headers = new Headers(init.headers);
    headers.set('x-fixture-read-grants', flag);
    if (ownerInvites || headers.get('cookie') === `${cookie(memberToken).name}=${memberToken}`) headers.set('x-fixture-invite', '1');
    const path = new URL(resource).pathname;
    const response = await worker.fetch(resource, { ...init, headers });
    if (path.includes('/read-grants/') || (init.method === 'POST' && path.startsWith('/api/owner/'))) writes.push([init.method, path, response.status]);
    if (failRead && path.endsWith('/eligible-recipients')) {
      await response.arrayBuffer();
      return new Response(null, { status: 503 });
    }
    return response;
  } };
  const ask = (path, token = ownerToken, method = 'GET') => target.fetch(origin + path, {
    method, redirect: 'manual', headers: { cookie: `${cookie(token).name}=${token}`, origin, 'sec-fetch-site': 'same-origin' },
  });
  const output = process.env.DRIVE_BROWSER_EVIDENCE_DIR;
  for (const [width, height, id, name] of [[1280, 800, folder, folderName], [390, 844, file, fileName]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    let hold = false, beforeRosterReply;
    const release = [];
    try {
      await context.route('**/*', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        let wait = path === roster(id) ? beforeRosterReply : undefined;
        if (hold && [roster(id), grant(id, second)].includes(path)) {
          const gate = Promise.withResolvers();
          release.push(gate.resolve);
          wait = () => gate.promise;
        } else if (hold && request.method() === 'PUT' && path === grant(id, reader)) {
          wait = () => new Promise(resolve => setTimeout(resolve, 6_000));
        }
        try { await relay(route, target, 'same-origin', wait); }
        catch (error) { if (!wait || !request.failure()) throw error; }
      });
      const page = await context.newPage(), { keyboard } = page;
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const prefix = `root-share-${width}x${height}`;
      const audit = state => capture(page, state, width, true, 'root-share');
      const visit = () => page.goto(origin + '/', { waitUntil: 'networkidle' });
      const signedOut = await target.fetch(origin + '/', { method: 'GET', redirect: 'manual',
        headers: { 'x-fixture-navigation': '1', 'sec-fetch-site': 'none' } });
      assert.deepEqual([signedOut.status, signedOut.headers.get('location')], [303, '/sign-in?next=%2F']);
      await page.goto(origin + signedOut.headers.get('location'), { waitUntil: 'networkidle' });
      await audit('signed-out');
      await context.addCookies([{ ...cookie(ownerToken), url: origin }]);
      const triggerFor = entryName => page.getByRole('button', { name: `Actions for ${entryName}` });
      const trigger = triggerFor(name);
      flag = 'true';
      await visit();
      assert.equal(await trigger.count(), 0);
      assert.equal((await ask(roster(id))).status, 404);
      assert.equal((await ask(grant(id, reader), ownerToken, 'PUT')).status, 404);
      flag = '1';
      await visit();
      await audit('root');
      const menu = page.getByRole('menu'), dialog = page.getByRole('dialog', { name: `Share “${name}”` });
      const input = dialog.getByRole('combobox', { name: 'Add people' });
      const button = name => dialog.getByRole('button', { name, exact: true });
      const focused = locator => locator.and(page.locator(':focus')).waitFor();
      const tabTo = (name, key = 'Tab') => keyboard.press(key).then(() => focused(button(name)));
      const live = text => dialog.getByRole('status').filter({ hasText: text }).waitFor();
      const turn = (direction, subject, number) => button(`${direction} page of ${subject}`).press('Enter')
        .then(() => live(`Showing page ${number} of ${subject}.`));
      const open = async () => { await trigger.press('ArrowDown'); await keyboard.press('Enter'); await dialog.waitFor(); };
      const updateGrant = async (who, method) => assert.equal((await ask(grant(id, who), ownerToken, method)).status, 204);
      const setRoster = status => DB.prepare("UPDATE drive_principals SET status = ? WHERE id = 'member' OR id GLOB 'share-reader-*'").bind(status).run();
      const empty = dialog.getByText('There’s nobody else on this drive yet.', { exact: true });
      const select = async (label, count) => {
        await input.fill(label);
        await keyboard.press('ArrowDown');
        await keyboard.press('Enter');
        await live(`${label} selected. ${count} selected.`);
      };
      await open(); await select(names[0], 1);
      await turn('Next', 'people to add', 2); await setRoster('revoked');
      await button('Previous page of people to add').press('Enter'); await empty.waitFor();
      assert.equal(await button('Share').getAttribute('aria-disabled'), 'true');
      assert.equal(await button('Invite someone').count(), 0);
      assert.equal((await ask('/people')).status, 404);
      await focused(button('Done')); await keyboard.press('Enter');
      ownerInvites = true; writes = []; await visit(); await open(); await empty.waitFor();
      const onlyYou = dialog.getByText('Only you can see this.', { exact: true });
      await onlyYou.waitFor();
      await audit('invite-empty');
      const inviteTree = await dialog.ariaSnapshot();
      assert.match(inviteTree, /button "Invite someone"/);
      await focused(button('Done'));
      await tabTo('Close');
      await tabTo('Invite someone');
      const people = page.waitForResponse(response => response.url() === origin + '/people' && response.request().isNavigationRequest());
      await keyboard.press('Enter'); assert.equal((await people).status(), 200);
      await page.getByRole('heading', { name: 'Users and invites' }).waitFor();
      const peopleTree = await page.locator('body').ariaSnapshot();
      assert.match(peopleTree, /link "Users and invites"[\s\S]*main:[\s\S]*heading "Users and invites"/);
      assert.deepEqual(writes, []);
      ownerInvites = false; await visit();
      await DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'member'").run();
      await updateGrant('member', 'PUT');
      await open();
      await button('Remove Name unavailable’s access').waitFor();
      assert.equal(await empty.count(), 0, 'A complete roster with only granted recipients is not empty');
      await button('Done').press('Enter');
      await updateGrant('member', 'DELETE');
      await setRoster('active');
      await DB.prepare("INSERT INTO drive_sessions VALUES (?, 'member', ?)").bind(session.token_hash, session.expires_at).run();
      await trigger.press('ArrowDown');
      await focused(menu.getByRole('menuitem', { name: 'Share' }));
      const read = page.waitForResponse(response => new URL(response.url()).pathname === roster(id));
      await keyboard.press('Enter');
      await focused(input);
      assert.equal((await read).status(), 200);
      await button('Next page of people with access').waitFor();
      assert.equal(await onlyYou.count(), 0);
      const nextRead = page.waitForResponse(response => new URL(response.url()).pathname === roster(id) && !!new URL(response.url()).search);
      await button('Next page of people with access').press('Enter');
      assert.equal((await nextRead).status(), 200);
      await live('Showing page 2 of people with access.');
      assert.equal(await onlyYou.count(), 0);
      await turn('Previous', 'people with access', 1);
      await input.fill(names[0]);
      await dialog.getByRole('option', { name: names[0] }).waitFor();
      const pickerTree = await dialog.ariaSnapshot();
      assert.match(pickerTree, /combobox "Add people" \[expanded\][\s\S]*listbox "Available people"[\s\S]*option "Root Reader"/);
      assert.match(pickerTree, /You · owner/);
      assert.equal(/anything you add/.test(pickerTree), id === folder);
      await keyboard.press('Escape');
      assert(await dialog.isVisible() && !await dialog.getByRole('listbox').count());
      await button('Done').focus();
      await tabTo('Close');
      await tabTo('Done', 'Shift+Tab');
      await audit('dialog');
      await page.screenshot({ path: resolve(output, `${prefix}-greyscale.png`), style: 'dialog { filter: grayscale(1); }' });
      await page.setViewportSize({ width: 320, height });
      assert(await dialog.evaluate(el => [el, document.documentElement].every(box => box.scrollWidth <= box.clientWidth)));
      await page.screenshot({ path: resolve(output, `${prefix}-reflow.png`) });
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ forcedColors: 'active' });
      await tabTo('Close');
      assert(await button('Close').evaluate(el => getComputedStyle(el).outlineStyle === 'solid'));
      await page.screenshot({ path: resolve(output, `${prefix}-forced-colours.png`) });
      await page.emulateMedia({ forcedColors: 'none' });

      await select(names[0], 1);
      const selected = dialog.getByRole('list', { name: 'Selected people' });
      await turn('Next', 'people to add', 2);
      await select('Roster Person 101', 2);
      await updateGrant(late, 'PUT');
      await input.fill('NoSuchRecipient');
      beforeRosterReply = () => button('Remove Roster Person 101').focus();
      await button('Next page of people with access').press('Enter');
      await focused(input); beforeRosterReply = undefined; await live(/No matching people available on this page\..*removed from the selection/);
      await selected.getByText(names[0]).waitFor();
      assert.equal(await selected.getByText('Roster Person 101').count(), 0);
      await turn('Previous', 'people with access', 1);
      await input.fill('Roster Person 101');
      await live('No matching people available on this page.');
      await turn('Next', 'people with access', 2);
      await select('Roster Person 100', 2);
      await updateGrant(reader, 'PUT');
      await button('Previous page of people to add').press('Enter');
      await live('removed from the selection');
      await selected.getByText('Roster Person 100').waitFor();
      assert.equal(await selected.getByText(names[0]).count(), 0);
      assert.equal(await button('Previous page of people with access').count(), 1);
      await button('Done').press('Enter');
      await updateGrant(late, 'DELETE');
      await updateGrant(reader, 'DELETE');
      await open();
      for (const [index, label] of names.entries()) await select(label, index + 1);

      writes = [];
      hold = true;
      const aborted = (path, timeout) => page.waitForEvent('requestfailed', { predicate: request =>
        new URL(request.url()).pathname === path && request.failure()?.errorText === 'net::ERR_ABORTED', timeout });
      const expiredWrite = aborted(grant(id, second), 19_000);
      await button('Share with 3 people').press('Enter');
      await expiredWrite;
      const notice = dialog.getByRole('alert').filter({ hasText: 'Couldn’t confirm sharing with Second Reader.' });
      await focused(notice);
      assert.match(await notice.textContent(), /Shared with Root Reader\..*Sharing wasn’t sent for Third Reader\./);
      assert.equal(await selected.count(), 0);
      assert.equal(await button('Done').getAttribute('aria-disabled'), 'false');
      assert.deepEqual(writes, [['PUT', grant(id, reader), 204], ['PUT', grant(id, second), 204]]);
      await aborted(roster(id), 8_000);
      await dialog.getByText('Couldn’t load people with access.', { exact: true }).waitFor();
      assert.match(await notice.textContent(), /Shared with Root Reader\./);
      hold = false;
      release.splice(0).forEach(done => done());
      await button('Retry loading people with access').press('Enter');
      await button('Retry loading people to add').press('Enter');
      await button('Remove Second Reader’s access').waitFor();
      assert.equal(writes.length, 2);
      if (id === folder) {
        const nested = async () => (await (await ask(roster(child))).json()).recipients.find(row => row.recipientId === reader);
        assert.deepEqual(await nested(), { recipientId: reader, displayName: names[0], direct: false, inheritedFrom: folderName });
      }
      const resultTree = await dialog.ariaSnapshot();
      assert.match(resultTree, /heading "People with access"[\s\S]*button "Remove Root Reader’s access"/);
      assert(![pickerTree, resultTree].some(tree => tree.includes(reader)));
      await select(names[2], 1);
      failRead = true;
      await button('Share').press('Enter');
      await dialog.getByText('Couldn’t load people to add.', { exact: true }).waitFor();
      await live('Shared with Third Reader');
      assert.deepEqual(writes.at(-1), ['PUT', grant(id, third), 204]);
      failRead = false;
      await updateGrant(third, 'DELETE');
      await button('Retry loading people with access').press('Enter');
      await button('Remove Root Reader’s access').press('Enter');
      failRead = true;
      await button('Confirm removal of direct access for Root Reader').press('Enter');
      await live('Removed direct access for Root Reader.');
      await dialog.getByText('Couldn’t load people with access.', { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('status').textContent(), 'Removed direct access for Root Reader.');
      failRead = false;
      assert.deepEqual(writes.at(-1), ['DELETE', grant(id, reader), 204]);
      await keyboard.press('Escape');
      await focused(trigger);
      if (id === folder) {
        hold = true;
        await Promise.all([page.waitForRequest(request => new URL(request.url()).pathname === roster(id)), open()]);
        await page.setViewportSize({ width: 390, height: 844 });
        await Promise.all([aborted(roster(id), 3_000), button('Done').press('Enter')]);
        hold = false;
        release.splice(0).forEach(done => done());
        await focused(page.getByRole('list', { name: /^Contents of My Drive/ }).getByRole('button', { name: `Actions for ${name}` }));
        await page.setViewportSize({ width, height });
      }

      await updateGrant('member', 'PUT');
      await context.addCookies([{ ...cookie(memberToken), url: origin }]);
      await visit();
      await triggerFor(memberName).waitFor();
      assert.equal(await trigger.count(), 0);
      assert.equal((await ask(roster(id), memberToken)).status, 404);
      assert.equal((await ask(grant(id, third), memberToken, 'PUT')).status, 404);
      assert.equal((await ask(grant(id, 'member'), memberToken, 'DELETE')).status, 404);
      const { recipients: afterDenial } = await (await ask(roster(id))).json();
      assert.equal(afterDenial.find(row => row.recipientId === third).direct, false);
      assert.equal(afterDenial.find(row => row.recipientId === 'member').direct, true);
      assert.deepEqual(errors, []);
      await writeFile(resolve(output, `${prefix}-aria-review.txt`), [
        'ShareDialog exposes its entry-named dialog, owner and access heading, the permission description and the direct removal button.',
        'ShareRecipientPicker exposes the Add people combobox, its expanded listbox and the labelled option without exposing recipient IDs.',
        'The status region updated for paging, selection and removal. A focused alert distinguished acknowledged, uncertain and unsent shares across a read timeout.',
        'Keyboard opened the menu, moved into Share, dismissed the picker on Escape, wrapped both directions, and returned focus to the row.',
        'Reduced motion enabled, forced-colours focus visible, and no horizontal overflow at 320 CSS px. Chromium accessibility tree review.',
        'With invite admission enabled, Tab reached Invite someone and Enter opened the Users and invites document. The action was absent with invite admission disabled.',
        pickerTree, resultTree, inviteTree, peopleTree,
      ].join('\n\n'));
      console.log(`Root Share passed at ${width}×${height}`);
    } finally {
      release.forEach(done => done());
      await context.close();
    }
  }
}
