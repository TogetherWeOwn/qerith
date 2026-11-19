import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { RecoveryChallenges } from '../../drive/src/lib/server/identity/recovery-challenge.ts';
import { RecoveryRedemption } from '../../drive/src/lib/server/identity/recovery-redemption.ts';
import { RecoveryTokens } from '../../drive/src/lib/server/identity/recovery.ts';
import { PasskeyLogin } from '../../drive/src/lib/server/identity/login.ts';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';
import { fixture, rpID, origin, userHandle } from '../../drive/tests/ceremony-fixture.ts';

let owner, recovery, challenges, redemption, sessions;
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec(`DELETE FROM drive_bound_ceremonies; DELETE FROM drive_recovery_tokens;
    DELETE FROM drive_sessions; DELETE FROM drive_credentials; DELETE FROM drive_principals;
    INSERT INTO drive_principals (id, role, status) VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active')`);
  sessions = new Sessions(env.DB);
  owner = (await sessions.issue('owner')).token;
  recovery = new RecoveryTokens(env.DB);
  challenges = new RecoveryChallenges(env.DB);
  redemption = new RecoveryRedemption(env.DB, rpID, origin);
});

async function prepared() {
  const issued = await recovery.issue(owner, 'member');
  const challenge = await challenges.issue(issued.token);
  const signed = await fixture('registration', { challenge });
  return { issued, challenge, signed };
}

it('replaces credentials and sessions, fences login, and consumes competing tokens atomically', async () => {
  const oldSession = (await sessions.issue('member')).token;
  await env.DB.prepare("INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports) VALUES ('old', 'member', x'01', 0, '[]')").run();
  const login = new PasskeyLogin(env.DB, rpID, origin);
  const loginChallenge = await login.issueChallenge('old-login');
  const generation = (await env.DB.prepare("SELECT generation FROM drive_login_generations WHERE principal_id = 'member'").first()).generation;
  const competing = await prepared();
  const { issued, challenge, signed } = await prepared();
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => redemption.redeem(issued.token, challenge, signed.registration)));
  const successes = attempts.filter(result => result.status === 'fulfilled');
  expect(successes, attempts.filter(result => result.status === 'rejected').map(result => String(result.reason)).join('\n')).toHaveLength(1);
  expect(await sessions.lookup(successes[0].value.token)).toEqual({ id: 'member', role: 'member' });
  expect(await sessions.lookup(oldSession)).toBeNull();
  const credentials = await env.DB.prepare("SELECT id, principal_id FROM drive_credentials WHERE principal_id = 'member'").all();
  expect(credentials.results).toEqual([{ id: signed.registration.id, principal_id: 'member' }]);
  expect((await env.DB.prepare("SELECT generation FROM drive_login_generations WHERE principal_id = 'member'").first()).generation).not.toBe(generation);
  expect(await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE challenge = ?').bind(loginChallenge).first()).toBeNull();
  expect((await env.DB.prepare('SELECT redeemed_at FROM drive_recovery_tokens WHERE id = ?').bind(issued.id).first()).redeemed_at).toBeGreaterThan(0);
  expect((await env.DB.prepare('SELECT cancelled_at FROM drive_recovery_tokens WHERE id = ?').bind(competing.issued.id).first()).cancelled_at).toBeGreaterThan(0);
  await expect(redemption.redeem(competing.issued.token, competing.challenge, competing.signed.registration)).rejects.toThrow();
  await expect(redemption.redeem(issued.token, challenge, signed.registration)).rejects.toThrow();
});

it('invalidates links for every principal when the owner recovers', async () => {
  const member = await prepared();
  const issued = await recovery.issue(owner, 'owner');
  const challenge = await challenges.issue(issued.token);
  const signed = await fixture('registration', { challenge });
  const db = {
    prepare: sql => env.DB.prepare(sql),
    async batch(statements) { return env.DB.batch(statements); },
  };
  const result = await new RecoveryRedemption(db, rpID, origin).redeem(issued.token, challenge, signed.registration);
  expect(await sessions.lookup(result.token)).toEqual({ id: 'owner', role: 'owner' });
  expect(await sessions.lookup(owner)).toBeNull();
  expect((await env.DB.prepare('SELECT cancelled_at FROM drive_recovery_tokens WHERE id = ?').bind(member.issued.id).first()).cancelled_at).toBeGreaterThan(0);
  expect(await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE challenge = ?').bind(member.challenge).first()).toBeNull();
  await expect(redemption.redeem(member.issued.token, member.challenge, member.signed.registration)).rejects.toThrow();
});

it('returns the session expiry from the transaction without a later read', async () => {
  const { issued, challenge, signed } = await prepared();
  let committed = false;
  const db = {
    prepare(sql) {
      if (committed) throw new Error('post-commit read unavailable');
      return env.DB.prepare(sql);
    },
    async batch(statements) {
      const result = await env.DB.batch(statements);
      committed = true;
      return result;
    },
  };
  const session = await new RecoveryRedemption(db, rpID, origin).redeem(issued.token, challenge, signed.registration);
  expect(session.expiresAt).toBeGreaterThan(Date.now());
  expect(await sessions.lookup(session.token)).toEqual({ id: 'member', role: 'member' });
});

it('fails closed if the token or challenge changes before commit', async () => {
  for (const state of ['cancelled', 'token-expired', 'challenge-expired', 'replaced', 'revoked', 'reactivated']) {
    const { issued, challenge, signed } = await prepared();
    const db = {
      prepare: sql => env.DB.prepare(sql),
      async batch(statements) {
        if (state === 'cancelled') await recovery.cancel(owner, issued.id);
        if (state === 'token-expired') await env.DB.prepare('UPDATE drive_recovery_tokens SET expires_at = 1 WHERE id = ?').bind(issued.id).run();
        if (state === 'challenge-expired') await env.DB.prepare('UPDATE drive_bound_ceremonies SET expires_at = 1 WHERE challenge = ?').bind(challenge).run();
        if (state === 'replaced') await challenges.issue(issued.token);
        if (state === 'revoked' || state === 'reactivated') {
          await env.DB.exec("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'");
          if (state === 'reactivated') await env.DB.exec("UPDATE drive_principals SET status = 'active' WHERE id = 'member'");
        }
        return env.DB.batch(statements);
      },
    };
    await expect(new RecoveryRedemption(db, rpID, origin).redeem(issued.token, challenge, signed.registration)).rejects.toThrow();
    expect((await env.DB.prepare("SELECT count(*) AS n FROM drive_sessions WHERE principal_id = 'member'").first()).n).toBe(0);
    if (state === 'revoked') await env.DB.exec("UPDATE drive_principals SET status = 'active' WHERE id = 'member'");
  }
});

it('rolls back replacement and competing-token cleanup when final redemption fails', async () => {
  const oldSession = (await sessions.issue('member')).token;
  await env.DB.prepare("INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports) VALUES ('old', 'member', x'01', 0, '[]')").run();
  const competing = await prepared();
  const { issued, challenge, signed } = await prepared();
  const generation = (await env.DB.prepare("SELECT generation FROM drive_login_generations WHERE principal_id = 'member'").first()).generation;
  await env.DB.prepare(`CREATE TRIGGER fail_recovery BEFORE UPDATE OF redeemed_at ON drive_recovery_tokens
    WHEN NEW.redeemed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'redemption failed'); END`).run();
  try {
    await expect(redemption.redeem(issued.token, challenge, signed.registration)).rejects.toThrow();
    expect(await sessions.lookup(oldSession)).toEqual({ id: 'member', role: 'member' });
    expect(await env.DB.prepare("SELECT id FROM drive_credentials WHERE id = 'old'").first()).not.toBeNull();
    expect((await env.DB.prepare("SELECT generation FROM drive_login_generations WHERE principal_id = 'member'").first()).generation).toBe(generation);
    expect((await env.DB.prepare('SELECT cancelled_at FROM drive_recovery_tokens WHERE id = ?').bind(competing.issued.id).first()).cancelled_at).toBeNull();
    expect(await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE challenge = ?').bind(competing.challenge).first()).not.toBeNull();
    expect(await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE challenge = ?').bind(challenge).first()).not.toBeNull();
  } finally {
    await env.DB.exec('DROP TRIGGER fail_recovery');
  }
});

it('rejects an in-flight login that verified before recovery committed', async () => {
  const login = new PasskeyLogin(env.DB, rpID, origin);
  const loginChallenge = await login.issueChallenge('login-race');
  const assertion = await fixture('authentication', { challenge: loginChallenge });
  await env.DB.prepare("UPDATE drive_principals SET webauthn_user_handle = ? WHERE id = 'member'").bind(userHandle).run();
  await env.DB.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
    VALUES (?, 'member', ?, 0, '[]', ?)`).bind(assertion.credential.id, Array.from(assertion.credential.publicKey), userHandle).run();
  const { issued, challenge, signed } = await prepared();
  const db = {
    prepare: sql => env.DB.prepare(sql),
    async batch(statements) {
      await redemption.redeem(issued.token, challenge, signed.registration);
      return env.DB.batch(statements);
    },
  };
  await expect(new PasskeyLogin(db, rpID, origin).authenticate('login-race', loginChallenge, assertion.authentication)).rejects.toThrow();
  expect((await env.DB.prepare("SELECT count(*) AS n FROM drive_sessions WHERE principal_id = 'member'").first()).n).toBe(1);
});

it('rejects an unverified registration and rolls back all writes on credential conflict', async () => {
  const oldSession = (await sessions.issue('member')).token;
  await env.DB.prepare("INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports) VALUES ('old', 'member', x'01', 0, '[]')").run();
  const { issued, challenge, signed } = await prepared();
  const bad = await fixture('registration', { challenge, uv: false });
  await expect(redemption.redeem(issued.token, challenge, bad.registration)).rejects.toThrow();
  await env.DB.exec("INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports) VALUES ('conflict', 'owner', x'01', 0, '[]')");
  // The fixture uses a stable credential ID. Reserve it for a different principal.
  await env.DB.prepare('UPDATE drive_credentials SET id = ? WHERE id = ?').bind(signed.registration.id, 'conflict').run();
  await expect(redemption.redeem(issued.token, challenge, signed.registration)).rejects.toThrow();
  expect(await sessions.lookup(oldSession)).toEqual({ id: 'member', role: 'member' });
  expect(await env.DB.prepare("SELECT id FROM drive_credentials WHERE id = 'old'").first()).not.toBeNull();
  expect((await env.DB.prepare('SELECT redeemed_at FROM drive_recovery_tokens WHERE id = ?').bind(issued.id).first()).redeemed_at).toBeNull();
  expect(await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE challenge = ?').bind(challenge).first()).not.toBeNull();
});
