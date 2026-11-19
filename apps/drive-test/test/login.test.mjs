import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { PasskeyLogin } from '../../drive/src/lib/server/identity/login.ts';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';
import { fixture, rpID, origin, userHandle } from '../../drive/tests/ceremony-fixture.ts';

async function setup(options = {}) {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec(`DELETE FROM drive_sessions; DELETE FROM drive_bound_ceremonies;
    DELETE FROM drive_credentials; DELETE FROM drive_principals;`);
  await env.DB.prepare(`INSERT INTO drive_principals (id, role, status, webauthn_user_handle)
    VALUES ('member', 'member', 'active', ?)`).bind(userHandle).run();
  const login = new PasskeyLogin(env.DB, rpID, origin);
  const challenge = await login.issueChallenge('transaction');
  const signed = await fixture('authentication', { challenge, ...options });
  await env.DB.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
    VALUES (?, 'member', ?, 0, '[]', ?)`).bind(signed.credential.id, Array.from(signed.credential.publicKey), userHandle).run();
  return { login, challenge, signed };
}

it('verifies the assertion and issues one opaque session for concurrent replay', async () => {
  const { login, challenge, signed } = await setup();
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () =>
    login.authenticate('transaction', challenge, signed.authentication)));
  const successes = attempts.filter(result => result.status === 'fulfilled');
  expect(successes).toHaveLength(1);
  const session = successes[0].value;
  expect(await new Sessions(env.DB).lookup(session.token)).toEqual({ id: 'member', role: 'member' });
  expect((await env.DB.prepare('SELECT counter FROM drive_credentials').first()).counter).toBe(1);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_sessions').first()).n).toBe(1);
  await expect(login.authenticate('transaction', challenge, signed.authentication)).rejects.toThrow();
});

it('rejects invalid signatures, relying parties, origins and user verification', async () => {
  for (const options of [{ badSignature: true }, { rpID: 'other.test' },
    { origin: 'https://other.test' }, { uv: false }]) {
    const { login, challenge, signed } = await setup(options);
    await expect(login.authenticate('transaction', challenge, signed.authentication)).rejects.toThrow();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_sessions').first()).n).toBe(0);
    expect((await env.DB.prepare('SELECT counter FROM drive_credentials').first()).counter).toBe(0);
  }
});

it('consumes the challenge when assertion parsing or credential lookup fails', async () => {
  for (const failure of ['malformed', 'lookup']) {
    const { login, challenge, signed } = await setup();
    const db = {
      prepare(sql) {
        if (sql.includes('SELECT c.id, c.principal_id')) throw new Error('lookup failed');
        return env.DB.prepare(sql);
      },
      batch: statements => env.DB.batch(statements),
    };
    const attempt = failure === 'malformed'
      ? login.authenticate('transaction', challenge, null)
      : new PasskeyLogin(db, rpID, origin).authenticate('transaction', challenge, signed.authentication);
    await expect(attempt).rejects.toThrow();
    await expect(login.authenticate('transaction', challenge, signed.authentication)).rejects.toThrow();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_sessions').first()).n).toBe(0);
  }
});

it('rechecks membership, counter and both handle bindings when committing a verified assertion', async () => {
  for (const state of ['revoked', 'reactivated', 'counter', 'credential-handle', 'principal-handle']) {
    const { challenge, signed } = await setup();
    const db = {
      prepare: sql => env.DB.prepare(sql),
      async batch(statements) {
        if (state === 'counter') await env.DB.prepare('UPDATE drive_credentials SET counter = 2').run();
        else if (state === 'credential-handle') await env.DB.exec('UPDATE drive_credentials SET webauthn_user_handle = NULL');
        else if (state === 'principal-handle') await env.DB.exec('UPDATE drive_principals SET webauthn_user_handle = NULL');
        else {
          await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'").run();
          if (state === 'reactivated') await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'member'").run();
        }
        return env.DB.batch(statements);
      },
    };
    await expect(new PasskeyLogin(db, rpID, origin).authenticate('transaction', challenge, signed.authentication)).rejects.toThrow();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_sessions').first()).n).toBe(0);
  }
});

it('invalidates outstanding challenges across revocation and reactivation', async () => {
  for (const timing of ['before-login', 'after-lookup']) {
    const { challenge, signed } = await setup();
    const changeMembership = async () => {
      await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'").run();
      await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'member'").run();
    };
    if (timing === 'before-login') await changeMembership();
    const db = {
      prepare(sql) {
        const statement = env.DB.prepare(sql);
        if (timing !== 'after-lookup' || !sql.includes('SELECT c.id, c.principal_id')) return statement;
        return { bind(...values) { return { async first() {
          const row = await statement.bind(...values).first();
          await changeMembership();
          return row;
        } }; } };
      },
      batch: statements => env.DB.batch(statements),
    };
    await expect(new PasskeyLogin(db, rpID, origin).authenticate('transaction', challenge, signed.authentication)).rejects.toThrow();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_sessions').first()).n).toBe(0);
  }
});

it('rolls back session insertion when the counter update fails', async () => {
  const { login, challenge, signed } = await setup();
  await env.DB.prepare(`CREATE TRIGGER fail_login_counter BEFORE UPDATE OF counter ON drive_credentials
    BEGIN SELECT RAISE(ABORT, 'counter write failed'); END`).run();
  try {
    await expect(login.authenticate('transaction', challenge, signed.authentication)).rejects.toThrow();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_sessions').first()).n).toBe(0);
    expect((await env.DB.prepare('SELECT counter FROM drive_credentials').first()).counter).toBe(0);
    await expect(login.authenticate('transaction', challenge, signed.authentication)).rejects.toThrow();
  } finally {
    await env.DB.exec('DROP TRIGGER fail_login_counter');
  }
});

it('rejects expired challenges and revoked members', async () => {
  for (const state of ['expired', 'revoked']) {
    const { login, challenge, signed } = await setup();
    if (state === 'expired') await env.DB.prepare('UPDATE drive_bound_ceremonies SET expires_at = 1').run();
    else await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'").run();
    await expect(login.authenticate('transaction', challenge, signed.authentication)).rejects.toThrow();
    expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_sessions').first()).n).toBe(0);
  }
});
