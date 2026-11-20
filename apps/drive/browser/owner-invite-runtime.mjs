import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { capture, widths } from './root-listing.mjs';

export async function proveOwnerIssue(browser, { origin, relay, worker, defaultWorker, ownerToken }, metadata) {
  const people = `${origin}/people`, endpoint = `${origin}/api/owner/invitations`;
  const cookie = `__Host-drive-session=${ownerToken}`;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.addCookies([{ name: '__Host-drive-session', value: ownerToken, url: origin, httpOnly: true, secure: true }]);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await context.addInitScript(() => {
      addEventListener('pageshow', event => { window.restoredOwnerPage = event.persisted; });
    });
    let issuedToken, posts = 0;
    const page = await context.newPage();
    const nodes = new Set();
    page.on('response', response => {
      const { pathname } = new URL(response.url());
      if (response.ok() && pathname.startsWith('/_app/immutable/nodes/')) nodes.add(pathname);
    });
    await context.route('**/*', async route => {
      const request = route.request();
      if (issuedToken) {
        const headers = await request.allHeaders();
        assert.ok(![request.url(), JSON.stringify(headers), request.postData() ?? ''].some(value => value.includes(issuedToken)), 'owner token never leaves the dialog');
      }
      if (request.url() === endpoint && request.method() === 'POST') ++posts;
      return relay(route);
    });
    const captureState = async state => {
      for (const [width, height] of widths) {
        await page.setViewportSize({ width, height });
        await capture(page, state, width, true, 'staging-owner-invite');
      }
    };
    await page.goto(origin);
    await page.waitForLoadState('networkidle');
    await captureState('my-drive');
    const before = new Set(nodes);
    const nav = page.getByRole('link', { name: 'Users and invites' });
    assert.equal(await nav.getAttribute('href'), '/people');
    const [document] = await Promise.all([page.waitForResponse(people), nav.press('Enter')]);
    assert.equal(document.status(), 200);
    assert.equal((await document.allHeaders())['cache-control'], 'private, no-store');
    await page.waitForLoadState('networkidle');
    await captureState('people');
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
    await captureState('editing');
    await page.keyboard.press('Escape');
    assert.equal(await open.evaluate(el => el === document.activeElement), true);
    await open.press('Enter');
    await name.fill(metadata.displayName);
    await page.getByRole('textbox', { name: /Note for them/ }).fill(metadata.note);
    const [created] = await Promise.all([page.waitForResponse(endpoint), page.getByRole('button', { name: 'Make invite link' }).press('Enter')]);
    assert.equal(created.status(), 201);
    assert.equal(created.request().method(), 'POST');
    assert.deepEqual(created.request().postDataJSON(), metadata);
    const { id, token } = await created.json();
    issuedToken = token;
    const field = page.getByRole('textbox', { name: `Invite link for ${metadata.displayName}` });
    await field.waitFor();
    const link = await field.inputValue();
    assert.ok(link === `${origin}/invite#${token}`, 'field holds the exact fragment link');
    await page.getByRole('button', { name: 'Copy link' }).press('Enter');
    await page.getByRole('button', { name: 'Copied' }).waitFor();
    assert.ok(await page.evaluate(async expected => await navigator.clipboard.readText() === expected, link), 'clipboard matches the link');
    await page.evaluate(() => navigator.clipboard.writeText(''));
    assert.equal(await page.evaluate(needle => [location.href, JSON.stringify(history.state), document.cookie,
      JSON.stringify(localStorage), JSON.stringify(sessionStorage)].some(value => value.includes(needle)), token), false);
    // Never put the freshly minted value in a screenshot or an axe node snippet.
    await field.evaluate(el => { el.value = `${location.origin}/invite#REDACTED`; el.removeAttribute('value'); });
    await captureState('copied');
    await field.evaluate((el, value) => { el.value = value; }, link);
    await field.evaluate(el => addEventListener('pagehide', () => {
      const cleared = !el.value && !document.querySelector('dialog[open]');
      sessionStorage.setItem('owner-invite-cleaned-before-freeze', String(cleared));
    }, { once: true }));
    await page.goBack();
    await page.waitForURL(`${origin}/`);
    await page.goForward();
    await page.waitForURL(people);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('owner-invite-cleaned-before-freeze')), 'true');
    assert.equal(await page.locator('dialog[open], dialog input[readonly]').count(), 0);
    assert.equal(await page.evaluate(needle => document.documentElement.outerHTML.includes(needle), token), false);
    assert.equal(posts, 1);
    const restored = await page.evaluate(() => window.restoredOwnerPage === true);
    await writeFile(resolve(process.env.DRIVE_BROWSER_EVIDENCE_DIR, 'staging-owner-invite-round-trip.json'), JSON.stringify({
      copyMatchesFragment: true, browserBackForwardClearsLink: true, restoredFromBFCache: restored, posts,
    }, null, 2));
    return { id, token, ownerNodes: exclusive };
  } finally {
    await context.close();
  }
}
