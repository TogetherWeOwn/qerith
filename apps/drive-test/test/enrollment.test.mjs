import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Invitations } from '../../drive/src/lib/server/identity/invitations.ts';
import { InvalidMemberDisplayName, InvitationEnrollment } from '../../drive/src/lib/server/identity/enrollment.ts';
import { PasskeyLogin } from '../../drive/src/lib/server/identity/login.ts';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';
import { handleInviteAcceptance } from '../../drive/src/lib/server/invite-acceptance.ts';
import { fixture, rpID, origin } from '../../drive/tests/ceremony-fixture.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  // D1 state is shared between tests in this file.
  await env.DB.exec(`DELETE FROM drive_bound_ceremonies;
    DELETE FROM drive_credentials;
    DELETE FROM drive_invitations;
    DELETE FROM drive_principals;
    INSERT INTO drive_principals (id, role, status) VALUES ('owner', 'owner', 'active');`);
  const owner = (await new Sessions(env.DB).issue('owner')).token;
  return { owner, invitations: new Invitations(env.DB), enrollment: new InvitationEnrollment(env.DB, rpID, origin) };
}

it('atomically stores only the winning invitee name and signs in with the enrolled passkey', async () => {
  const { owner, invitations, enrollment } = await setup();
  const invite = await invitations.issue(owner, { displayName: 'Prefill', note: 'Invitation note' });
  const { challenge, user, authenticatorSelection } = await enrollment.issueOptions(invite.token);
  expect(authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  expect(user.id).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  const pending = await env.DB.prepare('SELECT principal_id, webauthn_user_handle FROM drive_bound_ceremonies WHERE challenge = ?').bind(challenge).first();
  expect(pending.webauthn_user_handle).toBe(user.id);
  expect(await env.DB.prepare('SELECT id FROM drive_principals WHERE id = ?').bind(pending.principal_id).first()).toBeNull();
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const signed = await fixture('registration', { challenge, key });
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, (_, i) =>
    enrollment.enroll(invite.token, challenge, signed.registration, `  José ${i}  `)));
  expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
  const winner = attempts.findIndex(({ status }) => status === 'fulfilled');
  const principal = attempts[winner].value;
  expect(principal).toBe(pending.principal_id);
  const readMember = () => env.DB.prepare('SELECT role, status, webauthn_user_handle, display_name FROM drive_principals WHERE id = ?')
    .bind(principal).first();
  expect(await readMember()).toEqual({ role: 'member', status: 'active', webauthn_user_handle: user.id, display_name: `José ${winner}` });
  const credential = await env.DB.prepare('SELECT principal_id, webauthn_user_handle, public_key, counter, transports FROM drive_credentials WHERE id = ?').bind(signed.registration.id).first();
  expect(credential.principal_id).toBe(principal);
  expect(credential.webauthn_user_handle).toBe(user.id);
  expect(Array.from(credential.public_key)).toEqual(Array.from(signed.credential.publicKey));
  expect(credential.counter).toBe(1);
  expect(JSON.parse(credential.transports)).toEqual([]);
  expect((await env.DB.prepare('SELECT redeemed_at FROM drive_invitations WHERE id = ?').bind(invite.id).first()).redeemed_at).toBeGreaterThan(0);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies').first()).n).toBe(0);
  await expect(enrollment.issueOptions(invite.token)).rejects.toThrow();
  await expect(enrollment.enroll(invite.token, challenge, signed.registration, 'Replayed name')).rejects.toThrow();
  expect((await readMember()).display_name).toBe(`José ${winner}`);
  expect(await env.DB.prepare('SELECT display_name, note FROM drive_invitations WHERE id = ?').bind(invite.id).first())
    .toEqual({ display_name: 'Prefill', note: 'Invitation note' });

  const login = new PasskeyLogin(env.DB, rpID, origin);
  const loginChallenge = await login.issueChallenge('member-sign-in');
  const { authentication } = await fixture('authentication', { challenge: loginChallenge, key, counter: 2 });
  authentication.response.userHandle = user.id;
  const session = await login.authenticate('member-sign-in', loginChallenge, authentication);
  expect(await new Sessions(env.DB).lookup(session.token)).toEqual({ id: principal, role: 'member' });
});

it('rejects bad ceremonies and unavailable invitations and challenges without partial writes', async () => {
  const { owner, invitations, enrollment } = await setup();
  for (const state of ['invalid', 'cancelled', 'invite-expired', 'challenge-expired', 'replaced', 'unbound', 'different-invite']) {
    const invite = await invitations.issue(owner);
    const { challenge, user } = await enrollment.issueOptions(invite.token);
    const signed = await fixture('registration', { challenge, uv: state !== 'invalid' });
    if (state === 'cancelled') await invitations.cancel(owner, invite.id);
    if (state === 'invite-expired') await env.DB.prepare('UPDATE drive_invitations SET expires_at = 1 WHERE id = ?').bind(invite.id).run();
    if (state === 'challenge-expired') await env.DB.prepare('UPDATE drive_bound_ceremonies SET expires_at = 1 WHERE challenge = ?').bind(challenge).run();
    if (state === 'replaced') {
      await env.DB.prepare('UPDATE drive_bound_ceremonies SET expires_at = expires_at - 10000 WHERE challenge = ?').bind(challenge).run();
      expect((await enrollment.issueOptions(invite.token)).user.id).not.toBe(user.id);
    }
    if (state === 'unbound') await env.DB.prepare('UPDATE drive_bound_ceremonies SET webauthn_user_handle = NULL WHERE challenge = ?').bind(challenge).run();
    const target = state === 'different-invite' ? await invitations.issue(owner) : invite;
    if (target !== invite) await enrollment.issueOptions(target.token);
    await expect(enrollment.enroll(target.token, challenge, signed.registration, 'Chosen name')).rejects.toThrow();
    expect((await env.DB.prepare('SELECT redeemed_at FROM drive_invitations WHERE id = ?').bind(target.id).first()).redeemed_at).toBeNull();
  }
  expect((await env.DB.prepare("SELECT count(*) AS n FROM drive_principals WHERE role = 'member'").first()).n).toBe(0);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_credentials').first()).n).toBe(0);
});

it('rejects malformed or oversized names without consuming the enrollment', async () => {
  const { owner, invitations, enrollment } = await setup();
  const invite = await invitations.issue(owner);
  const { challenge } = await enrollment.issueOptions(invite.token);
  const { registration } = await fixture('registration', { challenge });
  const expandsUnderNfc = String.fromCodePoint(0x0344).repeat(64);
  for (const name of [null, 42, '   ', 'a\0b', 'a\nb', '\ud800', '🌱'.repeat(65), expandsUnderNfc]) {
    await expect(enrollment.enroll(invite.token, challenge, registration, name)).rejects.toThrow(InvalidMemberDisplayName);
  }
  expect(await env.DB.prepare("SELECT id FROM drive_principals WHERE role = 'member'").first()).toBeNull();
  const name = '🌱'.repeat(64);
  const id = await enrollment.enroll(invite.token, challenge, registration, ` ${name} `);
  expect(await env.DB.prepare('SELECT display_name FROM drive_principals WHERE id = ?').bind(id).first())
    .toEqual({ display_name: name });
});

it('composes the HTTP boundary with real invitation enrollment without issuing a session', async () => {
  const { owner, invitations } = await setup();
  const send = (step, body) => handleInviteAcceptance(new Request(`${origin}/api/invites/${step}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), step, { DRIVE_ORIGIN: origin, DB: env.DB });
  const invite = await invitations.issue(owner, { displayName: 'Guest' });
  expect(await (await send('present', { token: invite.token })).json()).toEqual({ displayName: 'Guest', note: null });
  const starts = await Promise.all([send('challenge', { token: invite.token }), send('challenge', { token: invite.token })]);
  expect(starts.map((result) => result.status).sort()).toEqual([200, 429]);
  expect(starts.find((result) => result.status === 429).headers.get('retry-after')).toBe('60');
  const started = starts.find((result) => result.status === 200);
  const { options: { challenge } } = await started.json();
  const { registration } = await fixture('registration', { challenge });
  const body = { token: invite.token, challenge, response: registration };
  const attempts = await Promise.all([send('enroll', body), send('enroll', body)]);
  expect(attempts.map((result) => result.status).sort()).toEqual([204, 404]);
  for (const result of attempts) {
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(result.headers.get('cache-control')).toBe('private, no-store');
  }
  expect((await send('challenge', { token: invite.token })).status).toBe(404);
  expect(await env.DB.prepare("SELECT display_name FROM drive_principals WHERE role = 'member'").first())
    .toEqual({ display_name: null }); // The legacy route must not copy the invite prefill.
  for (const state of ['cancelled', 'expired']) {
    const other = await invitations.issue(owner);
    if (state === 'cancelled') await invitations.cancel(owner, other.id);
    else await env.DB.prepare('UPDATE drive_invitations SET expires_at = 1 WHERE id = ?').bind(other.id).run();
    expect((await send('present', { token: other.token })).status).toBe(404);
    expect((await send('challenge', { token: other.token })).status).toBe(404);
  }
});

it('rolls back invitation, challenge and principal when a credential is not unique', async () => {
  const { owner, invitations, enrollment } = await setup();
  const first = await invitations.issue(owner);
  const { challenge: firstChallenge } = await enrollment.issueOptions(first.token);
  const firstSigned = await fixture('registration', { challenge: firstChallenge });
  const id = await enrollment.enroll(first.token, firstChallenge, firstSigned.registration, 'First member');
  const second = await invitations.issue(owner);
  const { challenge } = await enrollment.issueOptions(second.token);
  const signed = await fixture('registration', { challenge });
  await expect(enrollment.enroll(second.token, challenge, signed.registration, 'Rolled back')).rejects.toThrow();
  expect((await env.DB.prepare('SELECT redeemed_at FROM drive_invitations WHERE id = ?').bind(second.id).first()).redeemed_at).toBeNull();
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies WHERE challenge = ?').bind(challenge).first()).n).toBe(1);
  expect((await env.DB.prepare("SELECT id, display_name FROM drive_principals WHERE role = 'member'").all()).results)
    .toEqual([{ id, display_name: 'First member' }]);
});
