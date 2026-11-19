import assert from 'node:assert/strict';
import { Invitations } from '../src/lib/server/identity/invitations.ts';
import { Membership } from '../src/lib/server/identity/membership.ts';
import { capture, widths } from './root-listing.mjs';

export async function proveInvite(browser, { origin, relay, worker, DB, ownerToken }) {
  const invites = new Invitations(DB);
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
    const document = await open();
    assert.equal(document.status(), 200);
    assert.equal((await document.allHeaders())['referrer-policy'], 'no-referrer');
    const field = page.getByRole('textbox', { name: 'Your name' });
    await field.waitFor();
    assert.equal(await field.inputValue(), 'Pell');
    assert.equal(await page.locator('blockquote').innerText(), 'Welcome to Drive!');
    assert.equal(page.url() === `${origin}/invite`, true);
    assert.equal(await page.evaluate(token => JSON.stringify(history.state).includes(token), token), false);
    for (const [width, height] of widths) {
      await page.setViewportSize({ width, height });
      await capture(page, 'valid', width, true, 'generated-invite');
    }
    const enrolled = page.waitForResponse(response => new URL(response.url()).pathname === '/api/invite/enroll');
    await field.press('Enter');
    const result = await enrolled;
    assert.equal(result.status(), 204);
    assert.equal((await result.allHeaders())['set-cookie'], undefined);
    await page.waitForURL(`${origin}/sign-in`);
    const replay = await worker.fetch(`${origin}/api/invite/enroll`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: result.request().postData() });
    assert.equal(replay.status, 404);
    await open();
    await page.getByRole('heading', { name: "This link doesn't work any more" }).waitFor();
    const signIn = () => page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await page.goto(`${origin}/sign-in`);
    await signIn();
    await page.getByRole('heading', { name: 'Your drive is empty.' }).waitFor();
    const id = await DB.prepare("SELECT id FROM drive_principals WHERE role = 'member'").first('id');
    const members = new Membership(DB);
    assert.equal(await members.setStatus(ownerToken, id, (await members.get(ownerToken, id)).generation, 'revoked'), true);
    assert.equal(await page.evaluate(async () => (await fetch('/api/root-listing')).status), 401);
    await page.goto(`${origin}/sign-in`);
    await signIn();
    await page.getByRole('heading', { name: 'Your access is turned off' }).waitFor();
    console.log('Generated Worker + Chromium + D1: invite redemption, replay denial, member sign-in, empty My Drive and revocation passed');
  } finally {
    await context.close();
  }
}
