import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import { proveMemberDownload } from './member-download.mjs';
import { proveOwnerIssue } from './owner-invite-runtime.mjs';
import { capture, widths } from './root-listing.mjs';

// The trusted browser lane starts with plain Node; transform only the fixture's service imports.
const [{ Invitations }, { Membership }] = await Promise.all([
  tsImport('../src/lib/server/identity/invitations.ts', import.meta.url),
  tsImport('../src/lib/server/identity/membership.ts', import.meta.url),
]);

export async function proveInvite(browser, { origin, relay, worker, DB, ownerToken, stagingRoot }) {
  const staging = !!stagingRoot;
  const invitations = '/api/owner/invitations';
  const owner = async (path, status, { method = 'GET', metadata } = {}) => {
    const body = metadata && JSON.stringify(metadata);
    const response = await worker.fetch(origin + path, { method, redirect: 'manual', body, headers: {
      origin, cookie: `__Host-drive-session=${ownerToken}`,
      ...(body && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString() }),
    } });
    assert.deepEqual([response.status, response.headers.get('cache-control')], [status, 'private, no-store']);
    return response;
  };
  const issue = async metadata => staging
    ? (await owner(invitations, 201, { method: 'POST', metadata })).json()
    : new Invitations(DB).issue(ownerToken, metadata);
  const list = async (suffix = '') => (await (await owner(invitations + suffix, 200)).json()).invitations;
  const first = await issue({ displayName: 'Rook' });
  const metadata = { displayName: 'Pell', note: 'Welcome to Drive!' };
  const created = staging ? await proveOwnerIssue(browser, { origin, relay, worker, ownerToken,
    defaultWorker: stagingRoot.defaultWorker }, metadata) : await issue(metadata);
  const { id: invitationId, token, ownerNodes = [] } = created;
  if (staging) {
    const ids = [first.id, invitationId].sort();
    const entries = await list();
    assert.deepEqual(entries.map(entry => entry.id), ids);
    assert.ok(![first.token, token].some(value => JSON.stringify(entries).includes(value)), 'list never returns invite tokens');
    assert.deepEqual((await list(`?after=${ids[0]}`)).map(entry => entry.id), ids.slice(1));
  }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const linkSource = 'https://message.example.test/';
    let followedLink = false;
    let failPresent = false;
    // Hold requests in the context relay so only one handler owns each route.
    const held = new Map();
    const holdNext = pathname => {
      const { promise, resolve } = Promise.withResolvers();
      held.set(pathname, promise);
      return resolve;
    };
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (staging && url.href === linkSource) return route.fulfill({ contentType: 'text/html',
        body: `<a href="${origin}/invite#${first.token}">Open invitation</a>` });
      if (url.origin !== origin) return route.abort();
      if (staging) {
        assert.ok([first.token, token].every(value => !request.url().includes(value)), 'token absent from request URL');
        if (request.isNavigationRequest() && url.pathname === '/invite' && !followedLink) {
          assert.equal(request.frame().url(), linkSource);
          followedLink = true;
          return relay(route, 'cross-site');
        }
        if (url.pathname.startsWith('/api/invite/')) {
          const headers = await request.allHeaders();
          assert.equal(headers.origin, origin);
          assert.equal(headers.referer, undefined);
        }
      }
      if (url.pathname === '/api/invite/present' && failPresent) {
        failPresent = false;
        return route.fulfill({ status: 503 });
      }
      const pending = held.get(url.pathname);
      if (held.delete(url.pathname)) await pending;
      return relay(route);
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    const open = () => page.goto(`${origin}/invite#${token}`);
    const scope = staging ? 'staging-invite' : 'generated-invite';
    const captureState = async state => {
      for (const [width, height] of widths) {
        await page.setViewportSize({ width, height });
        await capture(page, state, width, true, scope);
      }
    };
    let document;
    const recipientNodes = new Set();
    const recordNode = response => {
      const { pathname } = new URL(response.url());
      if (response.ok() && pathname.startsWith('/_app/immutable/nodes/')) recipientNodes.add(pathname);
    };
    if (staging) {
      await page.goto(linkSource);
      page.on('response', recordNode);
      [document] = await Promise.all([page.waitForResponse(`${origin}/invite`), page.getByRole('link', { name: 'Open invitation' }).click()]);
    } else document = await page.goto(`${origin}/invite#${first.token}`);
    if (staging) assert.ok(followedLink, 'followed the cross-site invitation link');
    assert.equal(document.status(), 200);
    const headers = await document.allHeaders();
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['cache-control'], 'private, no-store');
    const field = page.getByRole('textbox', { name: 'Your name' });
    await field.waitFor();
    assert.equal(await field.inputValue(), 'Rook');
    page.off('response', recordNode);
    assert.equal(page.url(), `${origin}/invite`);
    await field.fill('Unsaved name');
    await page.evaluate(token => { location.hash = token; }, token);
    const note = page.getByText('Welcome to Drive!', { exact: true });
    await note.waitFor();
    assert.equal(await field.inputValue(), 'Pell');
    assert.equal(page.url(), `${origin}/invite`);
    assert.equal(await page.evaluate(tokens => tokens.some(token => JSON.stringify(history.state).includes(token)),
      [first.token, token]), false);
    const dead = page.getByRole('heading', { name: "This link doesn't work any more" });
    await page.goBack();
    await dead.waitFor();
    await page.goForward();
    await dead.waitFor();
    await page.evaluate(token => { location.hash = token; }, token);
    await note.waitFor();
    await captureState('valid');
    if (staging) {
      const primary = page.getByRole('button', { name: 'Set up a passkey' });
      await page.getByRole('heading', { name: "You're invited to Drive", exact: true }).waitFor();
      await page.setViewportSize({ width: 320, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.keyboard.press('Tab');
      assert.deepEqual(await field.evaluate(el => [el === document.activeElement, getComputedStyle(el).outlineStyle]), [true, 'solid']);
      await page.keyboard.press('Tab');
      assert.deepEqual(await primary.evaluate(el => [el === document.activeElement, getComputedStyle(el).outlineStyle]), [true, 'solid']);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await field.evaluate(el => el === document.activeElement), true);
    }
    const releaseEnrollment = holdNext('/api/invite/enroll');
    const enrollPath = message => new URL(message.url()).pathname === '/api/invite/enroll';
    const [result] = await Promise.all([
      page.waitForResponse(enrollPath),
      (async () => {
        try {
          await Promise.all([page.waitForRequest(enrollPath), staging ? page.keyboard.press('Enter') : field.press('Enter')]);
          await page.evaluate(token => { location.hash = token; }, first.token);
          await page.waitForFunction(() => location.hash === '');
          await page.getByRole('button', { name: 'Saving your passkey…' }).waitFor();
          assert.equal(await field.inputValue(), 'Pell');
          if (staging) await captureState('saving');
        } finally { releaseEnrollment(); }
      })(),
    ]);
    assert.equal(result.status(), 204);
    assert.equal((await result.allHeaders())['set-cookie'], undefined);
    await page.waitForURL(`${origin}/sign-in`);
    assert.equal((await context.cookies(origin)).some(cookie => cookie.name === '__Host-drive-session'), false);
    const replay = await worker.fetch(`${origin}/api/invite/enroll`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: result.request().postData() });
    assert.equal(replay.status, 404);
    const releasePresent = holdNext('/api/invite/present');
    const status = page.getByRole('status');
    const [presented, loading] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/api/invite/present'),
      (async () => {
        try {
          await open();
          return await status.filter({ hasText: 'Checking the invite…' }).elementHandle();
        } finally { releasePresent(); }
      })(),
    ]);
    assert.equal(presented.status(), 404);
    await dead.waitFor();
    await status.filter({ hasText: "This link doesn't work any more" }).waitFor();
    assert.equal(await loading.evaluate(el => el === document.querySelector('[role="status"]')), true);
    assert.equal(await status.count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    await loading.dispose();
    if (staging) await captureState('dead-link');
    failPresent = true;
    await page.evaluate(token => { location.hash = token; }, first.token);
    await page.getByRole('heading', { name: 'Drive unavailable' }).waitFor();
    await status.filter({ hasText: 'Drive unavailable' }).waitFor();
    if (staging) await captureState('unavailable');
    const signIn = async (expectedStatus, keyboard = false) => {
      // The server renders the button before its client-side handler is installed.
      await page.waitForLoadState('networkidle');
      const primary = page.getByRole('button', { name: 'Sign in with a passkey' });
      if (keyboard) {
        await page.getByRole('heading', { name: 'Sign in to Drive', exact: true }).waitFor();
        await page.getByText('Drive is invite-only. If you lost your passkey, ask the owner for a sign-in link.', { exact: true }).waitFor();
        await page.keyboard.press('Tab');
        assert.deepEqual(await primary.evaluate(el => [el === document.activeElement, getComputedStyle(el).outlineStyle]), [true, 'solid']);
        await captureState('member-sign-in');
      }
      const [verification] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === '/api/sign-in/verify'),
        keyboard ? page.keyboard.press('Enter') : primary.click(),
      ]);
      assert.equal(verification.status(), expectedStatus);
    };
    await Promise.all([
      page.waitForURL(`${origin}/sign-in`),
      page.getByRole('link', { name: 'Sign in', exact: true }).click(),
    ]);
    if (staging) await page.goto(`${origin}/sign-in?next=%2Fpeople`);
    await signIn(204, staging);
    await page.waitForURL(`${origin}/`);
    await page.getByRole('heading', { name: 'Your drive is empty.', exact: true }).waitFor();
    const id = await DB.prepare("SELECT id FROM drive_principals WHERE role = 'member' AND webauthn_user_handle IS NOT NULL").first('id');
    let memberRoot;
    if (staging) {
      await captureState('member-root-empty');
      memberRoot = await proveMemberRoot(page, context, { origin, worker, DB, id, checkOwner: owner, ...stagingRoot }, captureState);
      assert.equal(await page.getByRole('link', { name: 'Users and invites' }).count(), 0);
      for (const path of ownerNodes) await memberRoot.check(path, 'GET', 404);
    }
    await open();
    await page.getByRole('heading', { name: "You're signed in", exact: true }).waitFor();
    await status.filter({ hasText: "You're signed in" }).waitFor();
    await captureState('signed-in');
    if (staging) {
      assert.equal(await page.getByText("This invite is for someone else, so it wasn't used.", { exact: true }).count(), 1);
      assert.equal(await page.getByRole('link', { name: 'Go to My Drive' }).getAttribute('href'), '/');
    }
    if (staging) await owner(`/api/owner/members/${id}/revoke`, 204, { method: 'POST' });
    else {
      const members = new Membership(DB);
      assert.equal(await members.setStatus(ownerToken, id, (await members.get(ownerToken, id)).generation, 'revoked'), true);
    }
    await page.evaluate(token => { location.hash = token; }, first.token);
    await field.waitFor();
    assert.equal(await field.inputValue(), 'Rook');
    if (staging) {
      for (const [path, method] of [['/', 'GET'], ['/', 'HEAD'], [memberRoot.dataPath, 'GET'],
        [stagingRoot.asset, 'GET'], [invitations, 'GET'], ['/people', 'GET'], ...ownerNodes.map(path => [path, 'GET'])]) {
        await memberRoot.check(path, method, 401);
      }
      await memberRoot.checkRevoked();
      assert.deepEqual((await list()).map(entry => entry.id), [first.id]);
      await owner(`${invitations}/${first.id}/cancel`, 204, { method: 'POST' });
      assert.deepEqual(await list(), []);
      const cancelled = await worker.fetch(`${origin}/api/invite/present`, { method: 'POST',
        headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: first.token }) });
      assert.equal(cancelled.status, 404);
    } else assert.equal(await page.evaluate(async () => (await fetch('/api/root-listing')).status), 401);
    await page.goto(`${origin}/sign-in`);
    await signIn(403);
    await page.getByRole('heading', { name: 'Your access is turned off', exact: true }).waitFor();
    if (staging) {
      await page.getByText('The owner turned off your access to Drive. Your files are kept. Ask them if you think this is a mistake.', { exact: true }).waitFor();
      await captureState('member-revoked');
    }
    console.log(`${staging ? 'Staging-mode' : 'Generated'} Worker + Chromium + D1: invite enrollment, replay denial, member sign-in, private My Drive and revocation passed`);
    return [...recipientNodes];
  } finally {
    await context.close();
  }
}

async function proveMemberRoot(page, context, { worker, asset, ...options }, captureState) {
  const { origin, ownerFile } = options;
  const session = (await context.cookies(origin)).find(cookie => cookie.name === '__Host-drive-session');
  assert.ok(session?.httpOnly && session.secure);
  const cookie = `${session.name}=${session.value}`;
  const dataPath = '/__data.json?x-sveltekit-invalidated=01';
  const check = async (path, method, status, headers = {}) => {
    const response = await worker.fetch(origin + path, { method, headers: { origin, cookie, ...headers }, redirect: 'manual' });
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return response;
  };
  assert.equal(await (await check('/', 'HEAD', 200)).text(), '');
  await check(asset, 'GET', 200);
  const { name, checkRevoked } = await proveMemberDownload(page, { ...options, cookie, check, captureState });
  const data = await (await check(dataPath, 'GET', 200)).text();
  assert.ok(data.includes(name) && !data.includes(ownerFile.name) && !data.includes('internal-member-fixture-key'));
  await check(dataPath, 'GET', 403, { 'sec-fetch-site': 'cross-site' });
  for (const [path, method, status] of [
    ['/api/uploads', 'POST', 403], ['/api/owner/invitations', 'GET', 403], ['/people', 'GET', 404]]) {
    await check(path, method, status);
  }
  return { check, dataPath, checkRevoked };
}
