import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function proveOwnerIssue(browser, { origin, relay, worker, defaultWorker, ownerToken }, metadata) {
  const people = `${origin}/people`, endpoint = `${origin}/api/owner/invitations`;
  const cookie = `__Host-drive-session=${ownerToken}`;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const lateResponse = Promise.withResolvers();
  try {
    await context.addCookies([{ name: '__Host-drive-session', value: ownerToken, url: origin, httpOnly: true, secure: true }]);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await context.addInitScript(() => {
      addEventListener('pageshow', event => { window.restoredOwnerPage = event.persisted; });
    });
    let issued, posts = 0;
    const page = await context.newPage();
    const nodes = new Set();
    page.on('response', response => {
      const { pathname } = new URL(response.url());
      if (response.ok() && pathname.startsWith('/_app/immutable/nodes/')) nodes.add(pathname);
    });
    await context.route('**/*', async route => {
      const request = route.request();
      if (issued) {
        const headers = await request.allHeaders();
        assert.ok(![request.url(), JSON.stringify(headers), request.postData() ?? ''].some(value => value.includes(issued.token)), 'owner token never leaves the dialog');
      }
      if (request.url() === endpoint && request.method() === 'POST' && ++posts > 1) {
        await lateResponse.promise;
        return route.fulfill({ status: 201, json: issued }); // A late success without a second D1 insert.
      }
      return relay(route);
    });
    const nav = page.getByRole('link', { name: 'Users and invites' });
    const dialog = page.getByRole('dialog', { name: 'Invite someone' });
    const tree = async (state, locator, ...expected) => {
      const snapshot = await locator.ariaSnapshot();
      assert.ok(!issued || !snapshot.includes(issued.token), 'accessibility evidence contains no bearer link');
      for (const item of expected) assert.match(snapshot, item);
      await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, `staging-owner-invite-${state}-tree.txt`), snapshot);
    };
    const captureState = async (state, audit = true) => {
      for (const [width, height] of widths) {
        await page.setViewportSize({ width, height });
        if (!audit) assert.equal(await nav.evaluate(el => getComputedStyle(el).textDecorationLine), 'underline');
        await capture(page, state, width, audit, 'staging-owner-invite');
      }
    };
    await page.goto(origin);
    await page.waitForLoadState('networkidle');
    await captureState('my-drive');
    const before = new Set(nodes);
    const [document] = await Promise.all([page.waitForResponse(people), nav.press('Enter')]);
    assert.equal(document.status(), 200);
    assert.equal((await document.allHeaders())['cache-control'], 'private, no-store');
    await page.waitForLoadState('networkidle');
    await captureState('people');
    await tree('people', page.locator('body'), /link "Skip to content"/, /banner:/, /navigation "Drive"/, /main:/, /heading "Users and invites"/);
    assert.equal(await nav.getAttribute('aria-current'), 'page');
    const grey = await page.addStyleTag({ content: 'html { filter: grayscale(1); }' });
    await captureState('people-greyscale', false);
    await grey.evaluate(el => el.remove());
    await page.emulateMedia({ forcedColors: 'active' });
    await captureState('people-forced-colours', false);
    await page.emulateMedia({ forcedColors: null });
    const exclusive = [...nodes].filter(path => !before.has(path));
    assert.ok(exclusive.length > 0, 'people loads at least one owner-only route node');
    for (const url of [people, ...exclusive.map(path => origin + path)]) {
      assert.equal((await defaultWorker.fetch(url, { headers: { cookie } })).status, 404);
      assert.equal((await worker.fetch(url, { headers: {} })).status, 401);
    }
    await page.setViewportSize({ width: 320, height: 844 });
    assert.equal(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth), true);
    const open = page.getByRole('button', { name: 'Invite someone' });
    const name = page.getByRole('textbox', { name: 'Name (optional)', exact: true });
    await open.press('Enter');
    assert.equal(await name.evaluate(el => el === document.activeElement), true);
    await tree('editing', dialog, /dialog "Invite someone"/, /textbox "Name \(optional\)"/, /textbox "Note for them/, /button "Make invite link"/);
    await captureState('editing');
    await page.keyboard.press('Escape');
    assert.equal(await open.evaluate(el => el === document.activeElement), true);
    await open.press('Enter');
    await name.fill(metadata.displayName);
    await page.getByRole('textbox', { name: /Note for them/ }).fill(metadata.note);
    const [created] = await Promise.all([page.waitForResponse(endpoint), page.getByRole('button', { name: 'Make invite link' }).press('Enter')]);
    assert.equal(created.status(), 201);
    assert.deepEqual(created.request().postDataJSON(), metadata);
    issued = await created.json();
    const { id, token } = issued;
    const field = page.getByRole('textbox', { name: `Invite link for ${metadata.displayName}` });
    await field.waitFor();
    const link = await field.inputValue();
    assert.ok(link === `${origin}/invite#${token}`, 'field holds the exact fragment link');
    // Redact before any evidence capture. Copy still reads the dialog's in-memory URL.
    await field.evaluate(el => { el.value = `${location.origin}/invite#REDACTED`; el.removeAttribute('value'); });
    const copy = dialog.getByRole('button', { name: 'Copy link' });
    await tree('issued', dialog, /textbox "Invite link for /, /button "Copy link"/, /REDACTED/);
    await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('Clipboard refused')) }));
    await copy.press('Enter');
    await dialog.getByRole('alert').filter({ hasText: 'Press Ctrl+C or ⌘C to copy, or press and hold the link and choose Copy.' }).waitFor();
    assert.equal(await field.evaluate(el => el === document.activeElement && el.selectionStart === 0 && el.selectionEnd === el.value.length), true);
    await tree('refused', dialog, /alert: Press Ctrl\+C/);
    await page.evaluate(() => { delete navigator.clipboard.writeText; });
    await copy.press('Enter');
    await page.getByRole('button', { name: 'Copied' }).waitFor();
    assert.ok(await page.evaluate(async expected => await navigator.clipboard.readText() === expected, link), 'clipboard matches the link');
    await page.evaluate(() => navigator.clipboard.writeText(''));
    assert.equal(await page.evaluate(needle => [location.href, JSON.stringify(history.state), document.cookie,
      JSON.stringify(localStorage), JSON.stringify(sessionStorage)].some(value => value.includes(needle)), token), false);
    await tree('copied', dialog, /status: Link copied/);
    await captureState('copied');
    await field.evaluate((el, value) => { el.value = value; }, link);
    await field.evaluate(el => addEventListener('pagehide', () => {
      const cleared = !el.value && !document.querySelector('dialog[open]');
      sessionStorage.setItem('owner-invite-cleaned-before-freeze', String(cleared));
    }, { once: true }));
    await page.goBack();
    assert.equal(page.url(), `${origin}/`);
    await page.goForward();
    await page.waitForURL(people);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('owner-invite-cleaned-before-freeze')), 'true');
    assert.equal(await page.locator('dialog[open], dialog input[readonly]').count(), 0);
    assert.equal(await page.evaluate(needle => document.documentElement.outerHTML.includes(needle), token), false);
    assert.equal(posts, 1);
    const restored = await page.evaluate(() => window.restoredOwnerPage === true);
    await page.evaluate(() => history.pushState(history.state, '', '#back-check'));
    await open.click();
    await Promise.all([page.waitForRequest(endpoint), dialog.getByRole('button', { name: 'Make invite link' }).click()]);
    assert.equal(await dialog.getByRole('status').textContent(), 'Making invite link…');
    await page.goBack();
    assert.equal(page.url(), people);
    await dialog.waitFor({ state: 'hidden' });
    await Promise.all([page.waitForResponse(endpoint), lateResponse.resolve()]);
    await open.click();
    await tree('uncertain', dialog, /alert: The invite may have been made/, /button "Done"/);
    assert.equal(await dialog.getByRole('textbox').or(dialog.getByRole('button', { name: 'Make invite link' })).count(), 0);
    assert.equal(posts, 2);
    await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, 'staging-owner-invite-round-trip.json'), JSON.stringify({
      copyMatchesFragment: true, browserBackForwardClearsLink: true, restoredFromBFCache: restored, sameDocumentBackWhileSaving: true, workerPosts: 1,
    }, null, 2));
    return { id, token, ownerNodes: exclusive };
  } finally {
    lateResponse.resolve();
    await context.close();
  }
}
