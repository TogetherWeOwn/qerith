import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Invitations } from '../../drive/src/lib/server/identity/invitations.ts';
import { InvitationEnrollment } from '../../drive/src/lib/server/identity/enrollment.ts';
import { PasskeyLogin } from '../../drive/src/lib/server/identity/login.ts';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';
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

it('atomically redeems once and signs in with the enrolled member passkey', async () => {
  const { owner, invitations, enrollment } = await setup();
  const invite = await invitations.issue(owner);
  const { challenge, user, authenticatorSelection } = await enrollment.issueOptions(invite.token);
  expect(authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  expect(user.id).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  const pending = await env.DB.prepare('SELECT principal_id, webauthn_user_handle FROM drive_bound_ceremonies WHERE challenge = ?').bind(challenge).first();
  expect(pending.webauthn_user_handle).toBe(user.id);
  expect(await env.DB.prepare('SELECT id FROM drive_principals WHERE id = ?').bind(pending.principal_id).first()).toBeNull();
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const signed = await fixture('registration', { challenge, key });
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => enrollment.enroll(invite.token, challenge, signed.registration)));
  expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
  const principal = attempts.find(({ status }) => status === 'fulfilled').value;
  expect(principal).toBe(pending.principal_id);
  expect(await env.DB.prepare('SELECT role, status, webauthn_user_handle FROM drive_principals WHERE id = ?').bind(principal).first())
    .toEqual({ role: 'member', status: 'active', webauthn_user_handle: user.id });
  const credential = await env.DB.prepare('SELECT principal_id, webauthn_user_handle, public_key, counter, transports FROM drive_credentials WHERE id = ?').bind(signed.registration.id).first();
  expect(credential.principal_id).toBe(principal);
  expect(credential.webauthn_user_handle).toBe(user.id);
  expect(Array.from(credential.public_key)).toEqual(Array.from(signed.credential.publicKey));
  expect(credential.counter).toBe(1);
  expect(JSON.parse(credential.transports)).toEqual([]);
  expect((await env.DB.prepare('SELECT redeemed_at FROM drive_invitations WHERE id = ?').bind(invite.id).first()).redeemed_at).toBeGreaterThan(0);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies').first()).n).toBe(0);
  await expect(enrollment.issueOptions(invite.token)).rejects.toThrow();
  await expect(enrollment.enroll(invite.token, challenge, signed.registration)).rejects.toThrow();

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
    if (state === 'replaced') expect((await enrollment.issueOptions(invite.token)).user.id).not.toBe(user.id);
    if (state === 'unbound') await env.DB.prepare('UPDATE drive_bound_ceremonies SET webauthn_user_handle = NULL WHERE challenge = ?').bind(challenge).run();
    const target = state === 'different-invite' ? await invitations.issue(owner) : invite;
    if (target !== invite) await enrollment.issueOptions(target.token);
    await expect(enrollment.enroll(target.token, challenge, signed.registration)).rejects.toThrow();
    expect((await env.DB.prepare('SELECT redeemed_at FROM drive_invitations WHERE id = ?').bind(target.id).first()).redeemed_at).toBeNull();
  }
  expect((await env.DB.prepare("SELECT count(*) AS n FROM drive_principals WHERE role = 'member'").first()).n).toBe(0);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_credentials').first()).n).toBe(0);
});

it('rolls back invitation, challenge and principal when a credential is not unique', async () => {
  const { owner, invitations, enrollment } = await setup();
  const first = await invitations.issue(owner);
  const { challenge: firstChallenge } = await enrollment.issueOptions(first.token);
  const firstSigned = await fixture('registration', { challenge: firstChallenge });
  await enrollment.enroll(first.token, firstChallenge, firstSigned.registration);
  const second = await invitations.issue(owner);
  const { challenge } = await enrollment.issueOptions(second.token);
  const signed = await fixture('registration', { challenge });
  await expect(enrollment.enroll(second.token, challenge, signed.registration)).rejects.toThrow();
  expect((await env.DB.prepare('SELECT redeemed_at FROM drive_invitations WHERE id = ?').bind(second.id).first()).redeemed_at).toBeNull();
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies WHERE challenge = ?').bind(challenge).first()).n).toBe(1);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM drive_principals WHERE role = 'member'").first()).n).toBe(1);
});
