import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { BoundChallenges } from '../../drive/src/lib/server/identity/challenges.ts';
import { OwnerBootstrap } from '../../drive/src/lib/server/identity/owner-bootstrap.ts';
import { fixture, rpID, origin, userHandle } from '../../drive/tests/ceremony-fixture.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec(`DELETE FROM drive_owner_registration;
    DELETE FROM drive_bound_ceremonies;
    DELETE FROM drive_credentials;
    DELETE FROM drive_invitations;
    DELETE FROM drive_principals;`);
  return new OwnerBootstrap(env.DB, rpID, origin);
}

it('persists the issued handle exactly once across competing completions and restart', async () => {
  const bootstrap = await setup();
  const options = await bootstrap.issueOptions();
  const { challenge, user: { id: handle } } = options;
  const state = await env.DB.prepare('SELECT * FROM drive_owner_registration').first();
  expect(state.challenge).toBe(challenge);
  expect(state.expires_at).toBeGreaterThan(Date.now());
  expect(state.webauthn_user_handle).toBe(handle);
  expect(handle).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  expect(handle).not.toBe(state.principal_id);
  expect(options.rp.id).toBe(rpID);
  expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
  expect(await env.DB.prepare('SELECT id FROM drive_principals').first()).toBeNull();

  const signed = await fixture('registration', { challenge });
  const response = { ...signed.registration, user: { id: userHandle } };
  const restarted = new OwnerBootstrap(env.DB, rpID, origin);
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => restarted.enroll(challenge, response)));
  expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
  expect(await env.DB.prepare('SELECT id, role, status, webauthn_user_handle FROM drive_principals').first())
    .toEqual({ id: state.principal_id, role: 'owner', status: 'active', webauthn_user_handle: handle });
  const credential = await env.DB.prepare('SELECT * FROM drive_credentials WHERE id = ?').bind(signed.registration.id).first();
  expect(credential.principal_id).toBe(state.principal_id);
  expect(credential.webauthn_user_handle).toBe(handle);
  expect(Array.from(credential.public_key)).toEqual(Array.from(signed.credential.publicKey));
  expect(credential.counter).toBe(1);
  expect(JSON.parse(credential.transports)).toEqual([]);
  expect(await env.DB.prepare('SELECT challenge FROM drive_owner_registration').first()).toBeNull();
  await expect(restarted.enroll(challenge, signed.registration)).rejects.toThrow();
  await expect(restarted.issueOptions()).rejects.toThrow();
});

it('rejects failed verification and expired, replaced or legacy challenges', async () => {
  const bootstrap = await setup();
  for (const state of ['invalid', 'expired', 'replaced', 'legacy']) {
    const options = await bootstrap.issueOptions();
    const challenge = state === 'legacy'
      ? await new BoundChallenges(env.DB).issue('owner-bootstrap', 'registration') : options.challenge;
    const signed = await fixture('registration', { challenge, uv: state !== 'invalid' });
    if (state === 'expired') await env.DB.prepare('UPDATE drive_owner_registration SET expires_at = 1').run();
    if (state === 'replaced') expect((await bootstrap.issueOptions()).user.id).not.toBe(options.user.id);
    await expect(bootstrap.enroll(challenge, signed.registration)).rejects.toThrow();
    expect(await env.DB.prepare('SELECT id FROM drive_principals').first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM drive_credentials').first()).toBeNull();
  }
});

it('never replaces an active or revoked owner or binds a legacy owner', async () => {
  for (const status of ['active', 'revoked']) {
    const bootstrap = await setup();
    const { challenge } = await bootstrap.issueOptions();
    const signed = await fixture('registration', { challenge });
    await env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('existing', 'owner', ?)").bind(status).run();
    await expect(bootstrap.enroll(challenge, signed.registration)).rejects.toThrow();
    await expect(bootstrap.issueOptions()).rejects.toThrow();
    expect((await env.DB.prepare('SELECT id, status, webauthn_user_handle FROM drive_principals').all()).results)
      .toEqual([{ id: 'existing', status, webauthn_user_handle: null }]);
    expect(await env.DB.prepare('SELECT id FROM drive_credentials').first()).toBeNull();
  }
});

it('rolls back the principal and retains the ceremony on a duplicate credential', async () => {
  const bootstrap = await setup();
  const { challenge } = await bootstrap.issueOptions();
  const signed = await fixture('registration', { challenge });
  await env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('member', 'member', 'active')").run();
  await env.DB.prepare('INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)')
    .bind(signed.registration.id, 'member', [1], 0, '[]').run();
  await expect(bootstrap.enroll(challenge, signed.registration)).rejects.toThrow();
  expect(await env.DB.prepare("SELECT id FROM drive_principals WHERE role = 'owner'").first()).toBeNull();
  expect(await env.DB.prepare('SELECT challenge FROM drive_owner_registration').first()).toEqual({ challenge });
  expect(await env.DB.prepare('SELECT principal_id, webauthn_user_handle FROM drive_credentials').first())
    .toEqual({ principal_id: 'member', webauthn_user_handle: null });
});
