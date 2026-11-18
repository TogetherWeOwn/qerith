import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { BoundChallenges } from '../../drive/src/lib/server/identity/challenges.ts';
import { readSession } from '../../drive/src/lib/server/request-auth.ts';
import { signIn } from '../../drive/src/lib/server/sign-in.ts';
import { fixture, origin, rpID, userHandle } from '../../drive/tests/ceremony-fixture.ts';

const otherHandle = 'A'.repeat(43);
const authEnv = () => ({ DRIVE_ORIGIN: origin, DB: env.DB });
const post = (step, headers = {}, body) => signIn(new Request(`${origin}/api/sign-in/${step}`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body,
}), step, authEnv());

async function begin(options = {}, status = 'active') {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec('DELETE FROM drive_sessions; DELETE FROM drive_bound_ceremonies; DELETE FROM drive_credentials; DELETE FROM drive_principals;');
  const response = await post('challenge');
  expect(response.status).toBe(200);
  const transaction = response.headers.get('set-cookie');
  expect(transaction).toMatch(/^__Host-drive-login=[\w.-]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=300$/);
  const { challenge, rpId, allowCredentials } = await response.json();
  expect(rpId).toBe(rpID);
  expect(allowCredentials).toBeUndefined();
  const signed = await fixture('authentication', { challenge, ...options });
  await env.DB.prepare(`INSERT INTO drive_principals (id, role, status, webauthn_user_handle)
    VALUES ('owner', 'owner', ?, ?)`).bind(status, userHandle).run();
  await env.DB.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
    VALUES (?, 'owner', ?, 0, '[]', ?)`).bind(signed.credential.id, Array.from(signed.credential.publicKey), userHandle).run();
  return { cookie: transaction.split(';')[0], body: JSON.stringify(signed.authentication) };
}

it('rejects missing, sibling and wrong destination origins before touching D1', async () => {
  for (const [url, source] of [[origin, null], [origin, 'https://sub.example.test'], ['https://sub.example.test', origin]]) {
    const request = new Request(url, { method: 'POST', headers: source ? { origin: source } : {} });
    expect((await signIn(request, 'challenge', authEnv())).status).toBe(403);
    expect((await signIn(request, 'verify', authEnv())).status).toBe(403);
  }
});

it('requires the browser transaction cookie and issues a hardened session only once', async () => {
  const { cookie, body } = await begin();
  expect((await post('verify', {}, body)).status).toBe(401);
  expect((await post('verify', { cookie: `${cookie}; ${cookie}` }, body)).status).toBe(401);
  const success = await post('verify', { cookie }, body);
  expect(success.status).toBe(204);
  expect(success.headers.get('cache-control')).toBe('private, no-store');
  expect(success.headers.getSetCookie()).toEqual([
    expect.stringMatching(/^__Host-drive-session=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/),
  ]);
  const cookiePair = success.headers.getSetCookie()[0].split(';')[0];
  const request = new Request(origin, { headers: { cookie: cookiePair } });
  expect((await readSession(request, env.DB)).principal).toEqual({ id: 'owner', role: 'owner' });
  expect((await post('verify', { cookie }, body)).status).toBe(401);
  await env.DB.exec("UPDATE drive_principals SET status = 'revoked'");
  expect(await readSession(request, env.DB)).toBeNull();
});

it('replaces a live challenge without retaining its slot or clearing the replacement on verification', async () => {
  const { cookie, body } = await begin();
  const replacements = await Promise.all([post('challenge', { cookie }), post('challenge', { cookie })]);
  expect(replacements.map(response => response.status).sort()).toEqual([200, 401]);
  const winner = replacements.find(response => response.status === 200);
  const loser = replacements.find(response => response.status === 401);
  expect(loser.headers.getSetCookie()).toEqual([]);
  const currentCookie = winner.headers.getSetCookie()[0].split(';')[0];
  const denied = await post('verify', { cookie: currentCookie }, body);
  expect(denied.status).toBe(401);
  expect(denied.headers.getSetCookie()).toEqual([]);
  const row = await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies').all();
  expect(row.results).toEqual([{ challenge: (await winner.json()).challenge }]);
});

it('reserves ceremony capacity for registration when authentication is full', async () => {
  const { cookie, body } = await begin();
  expect((await post('verify', { cookie }, body)).status).toBe(204);
  await env.DB.prepare(`WITH RECURSIVE slots(n) AS (VALUES (1) UNION ALL SELECT n + 1 FROM slots WHERE n < 512)
    INSERT INTO drive_bound_ceremonies (context, purpose, challenge, expires_at)
    SELECT 'slot-' || n, 'authentication', printf('%043d', n), ? FROM slots`).bind(Date.now() + 300_000).run();
  for (const headers of [{}, { cookie }]) {
    const refused = await post('challenge', headers);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(refused.headers.getSetCookie()).toEqual([]);
  }
  await expect(new BoundChallenges(env.DB).issue('registration-test', 'registration')).resolves.toMatch(/^[\w-]{43}$/);
});

it.each(['missing', 'malformed', 'other account', 'legacy', 'replacement'])('denies a %s user binding without revealing revocation', async state => {
  const { cookie, body } = await begin({}, 'revoked');
  const assertion = JSON.parse(body);
  if (state === 'missing') delete assertion.response.userHandle;
  if (state === 'malformed') {
    const malformed = `${userHandle.slice(0, -1)}F`; // Nonzero padding bits.
    await env.DB.batch(['drive_principals', 'drive_credentials'].map(table =>
      env.DB.prepare(`UPDATE ${table} SET webauthn_user_handle = ?`).bind(malformed)));
    assertion.response.userHandle = malformed;
  }
  if (state === 'other account') {
    await env.DB.prepare(`INSERT INTO drive_principals (id, role, status, webauthn_user_handle)
      VALUES ('other', 'member', 'active', ?)`).bind(otherHandle).run();
    assertion.response.userHandle = otherHandle;
  }
  if (state === 'legacy') await env.DB.exec('UPDATE drive_principals SET webauthn_user_handle = NULL');
  if (state === 'legacy' || state === 'replacement') await env.DB.exec('UPDATE drive_credentials SET webauthn_user_handle = NULL');
  const denied = await post('verify', { cookie }, JSON.stringify(assertion));
  expect(denied.status).toBe(401);
  expect(await denied.json()).toEqual({ code: 'denied' });
  expect(denied.headers.getSetCookie()).toEqual([]);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies').first()).n).toBe(0);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_sessions').first()).n).toBe(0);
});

it('consumes matched attempts and distinguishes revoked proof from generic denial', async () => {
  for (const state of ['oversized', 'expired', 'wrong-origin', 'bad-signature', 'revoked']) {
    const options = state === 'wrong-origin' ? { origin: 'https://other.test' } : { badSignature: state === 'bad-signature' };
    const { cookie, body } = await begin(options, state === 'revoked' || state === 'bad-signature' ? 'revoked' : 'active');
    if (state === 'expired') await env.DB.exec('UPDATE drive_bound_ceremonies SET expires_at = 1');
    const denied = await post('verify', { cookie }, state === 'oversized' ? ' '.repeat(16 * 1024) + body : body);
    expect(denied.status).toBe(state === 'revoked' ? 403 : 401);
    expect(await denied.json()).toEqual({ code: state === 'revoked' ? 'revoked' : 'denied' });
    expect(denied.headers.getSetCookie()).toEqual([]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies').first()).n)
      .toBe(state === 'expired' || state === 'oversized' ? 1 : 0);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_sessions').first()).n).toBe(0);
  }
});
