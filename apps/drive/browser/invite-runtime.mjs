import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import { capture, widths } from './root-listing.mjs';

// The trusted browser lane starts with plain Node; transform only the fixture's service imports.
const [{ Invitations }, { Membership }] = await Promise.all([
  tsImport('../src/lib/server/identity/invitations.ts', import.meta.url),
  tsImport('../src/lib/server/identity/membership.ts', import.meta.url),
]);

export async function proveInvite(browser, { origin, relay, worker, DB, ownerToken }) {
  const invites = new Invitations(DB);
  const first = await invites.issue(ownerToken, { displayName: 'Rook' });
  const { token } = await invites.issue(ownerToken, { displayName: 'Pell', note: 'Welcome to Drive!' });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? relay(route) : route.abort());
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    const open = () => page.goto(`${origin}/invite#${token}`);
    const document = await page.goto(`${origin}/invite#${first.token}`);
    assert.equal(document.status(), 200);
    const headers = await document.allHeaders();
    assert.equal(headers['referrer-policy'], 'no-referrer');
    assert.equal(headers['cache-control'], 'private, no-store');
    const field = page.getByRole('textbox', { name: 'Your name' });
    await field.waitFor();
    assert.equal(await field.inputValue(), 'Rook');
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
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height });
      await capture(page, 'valid', width, true, 'generated-invite');
    }
    const pending = Promise.withResolvers();
    await page.route('**/api/invite/enroll', async route => { await pending.promise; await relay(route); }, { times: 1 });
    const enrollPath = message => new URL(message.url()).pathname === '/api/invite/enroll';
    const dispatched = page.waitForRequest(enrollPath);
    const enrolled = page.waitForResponse(enrollPath);
    try {
      await field.press('Enter');
      await dispatched;
      await page.evaluate(token => { location.hash = token; }, first.token);
      await page.waitForFunction(() => location.hash === '');
      await page.getByRole('button', { name: 'Saving your passkey…' }).waitFor();
      assert.equal(await field.inputValue(), 'Pell');
    } finally { pending.resolve(); }
    const result = await enrolled;
    assert.equal(result.status(), 204);
    assert.equal((await result.allHeaders())['set-cookie'], undefined);
    await page.waitForURL(`${origin}/sign-in`);
    const replay = await worker.fetch(`${origin}/api/invite/enroll`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: result.request().postData() });
    assert.equal(replay.status, 404);
    await open();
    await dead.waitFor();
    await page.route('**/api/invite/present', route => route.fulfill({ status: 503 }), { times: 1 });
    await page.evaluate(token => { location.hash = token; }, first.token);
    await page.getByRole('heading', { name: 'Drive unavailable' }).waitFor();
    const signIn = () => page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await signIn();
    await page.getByRole('heading', { name: 'Your drive is empty.' }).waitFor();
    await open();
    await page.getByRole('heading', { name: "You're signed in" }).waitFor();
    const id = await DB.prepare("SELECT id FROM drive_principals WHERE role = 'member'").first('id');
    const members = new Membership(DB);
    assert.equal(await members.setStatus(ownerToken, id, (await members.get(ownerToken, id)).generation, 'revoked'), true);
    await page.evaluate(token => { location.hash = token; }, first.token);
    await field.waitFor();
    assert.equal(await field.inputValue(), 'Rook');
    assert.equal(await page.evaluate(async () => (await fetch('/api/root-listing')).status), 401);
    await page.goto(`${origin}/sign-in`);
    await signIn();
    await page.getByRole('heading', { name: 'Your access is turned off' }).waitFor();
    console.log('Generated Worker + Chromium + D1: invite redemption, replay denial, member sign-in, empty My Drive and revocation passed');
  } finally {
    await context.close();
  }
}
