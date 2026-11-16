import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { OwnerBootstrap } from '../../drive/src/lib/server/identity/owner-bootstrap.ts';
import { fixture, rpID, origin } from '../../drive/tests/ceremony-fixture.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec(`DELETE FROM drive_bound_ceremonies;
    DELETE FROM drive_credentials;
    DELETE FROM drive_invitations;
    DELETE FROM drive_principals;`);
  return new OwnerBootstrap(env.DB, rpID, origin);
}

it('persists a verified owner exactly once across competing completions and restart', async () => {
  const bootstrap = await setup();
  const challenge = await bootstrap.issueChallenge();
  const signed = await fixture('registration', { challenge });
  const restarted = new OwnerBootstrap(env.DB, rpID, origin);
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => restarted.enroll(challenge, signed.registration)));
  expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
  const principal = attempts.find(({ status }) => status === 'fulfilled').value;
  expect(await env.DB.prepare('SELECT role, status FROM drive_principals WHERE id = ?').bind(principal).first())
    .toEqual({ role: 'owner', status: 'active' });
  const credential = await env.DB.prepare('SELECT principal_id, public_key, counter, transports FROM drive_credentials WHERE id = ?').bind(signed.registration.id).first();
  expect(credential.principal_id).toBe(principal);
  expect(Array.from(credential.public_key)).toEqual(Array.from(signed.credential.publicKey));
  expect(credential.counter).toBe(1);
  expect(JSON.parse(credential.transports)).toEqual([]);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies').first()).n).toBe(0);
  await expect(restarted.enroll(challenge, signed.registration)).rejects.toThrow();
  await expect(restarted.issueChallenge()).rejects.toThrow();
});

it('rejects failed verification and expired, replaced or misbound challenges', async () => {
  const bootstrap = await setup();
  for (const state of ['invalid', 'expired', 'replaced', 'context', 'purpose']) {
    const challenge = await bootstrap.issueChallenge();
    const signed = await fixture('registration', { challenge, uv: state !== 'invalid' });
    if (state === 'expired') await env.DB.prepare('UPDATE drive_bound_ceremonies SET expires_at = 1 WHERE challenge = ?').bind(challenge).run();
    if (state === 'replaced') await bootstrap.issueChallenge();
    if (state === 'context') await env.DB.prepare("UPDATE drive_bound_ceremonies SET context = 'other' WHERE challenge = ?").bind(challenge).run();
    if (state === 'purpose') await env.DB.prepare("UPDATE drive_bound_ceremonies SET purpose = 'authentication' WHERE challenge = ?").bind(challenge).run();
    await expect(bootstrap.enroll(challenge, signed.registration)).rejects.toThrow();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM drive_principals WHERE role = 'owner'").first()).n).toBe(0);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_credentials').first()).n).toBe(0);
  }
});

it('never replaces an active or revoked owner', async () => {
  for (const status of ['active', 'revoked']) {
    const bootstrap = await setup();
    const challenge = await bootstrap.issueChallenge();
    const signed = await fixture('registration', { challenge });
    await env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('existing', 'owner', ?)").bind(status).run();
    await expect(bootstrap.enroll(challenge, signed.registration)).rejects.toThrow();
    await expect(bootstrap.issueChallenge()).rejects.toThrow();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_principals').first()).n).toBe(1);
  }
});

it('rolls back the principal and retains the challenge on a duplicate credential', async () => {
  const bootstrap = await setup();
  const challenge = await bootstrap.issueChallenge();
  const signed = await fixture('registration', { challenge });
  await env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('member', 'member', 'active')").run();
  await env.DB.prepare('INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)')
    .bind(signed.registration.id, 'member', [1], 0, '[]').run();
  await expect(bootstrap.enroll(challenge, signed.registration)).rejects.toThrow();
  expect((await env.DB.prepare("SELECT count(*) AS n FROM drive_principals WHERE role = 'owner'").first()).n).toBe(0);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies WHERE challenge = ?').bind(challenge).first()).n).toBe(1);
});
