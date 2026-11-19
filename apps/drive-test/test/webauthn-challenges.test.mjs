import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { WebAuthnChallenges } from '../../drive/src/lib/server/identity/challenges.ts';

it('consumes unexpired challenges once, including concurrent attempts', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const store = new WebAuthnChallenges(env.DB);
  await store.issue('one', 'authentication', Date.now() + 60000);
  expect(await store.consume('one', 'registration')).toBe(false);
  const results = await Promise.all(Array.from({ length: 10 }, () => store.consume('one', 'authentication')));
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await store.consume('one', 'authentication')).toBe(false);
  await expect(store.issue('one', 'authentication', Date.now() + 60000)).rejects.toThrow();
  await env.DB.prepare("INSERT INTO drive_webauthn_challenges VALUES ('expired', 'authentication', ?, 0)")
    .bind(Date.now() - 1).run();
  expect(await store.consume('expired', 'authentication')).toBe(false);
  await expect(store.issue('expired', 'authentication', Date.now() + 60000)).rejects.toThrow();
  await expect(store.issue('', 'authentication', Date.now() + 60000)).rejects.toThrow();
  await expect(store.issue('past', 'registration', Date.now() - 1)).rejects.toThrow();
});

it('rolls back a failed D1 batch, but never restores a committed consumption', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const store = new WebAuthnChallenges(env.DB);
  await store.issue('rollback', 'registration', Date.now() + 60000);
  await expect(env.DB.batch([
    env.DB.prepare("UPDATE drive_webauthn_challenges SET consumed = 1 WHERE challenge = 'rollback'"),
    env.DB.prepare("INSERT INTO drive_webauthn_challenges VALUES ('invalid', 'other', 1, 0)"),
  ])).rejects.toThrow();
  expect(await store.consume('rollback', 'registration')).toBe(true);
  // A later verifier failure cannot roll back the already committed update.
  expect(await store.consume('rollback', 'registration')).toBe(false);
  await env.DB.exec("CREATE TRIGGER reject_consume BEFORE UPDATE ON drive_webauthn_challenges BEGIN SELECT RAISE(ABORT, 'failure'); END;");
  await store.issue('failure', 'registration', Date.now() + 60000);
  await expect(store.consume('failure', 'registration')).rejects.toThrow();
  await env.DB.exec('DROP TRIGGER reject_consume');
  expect(await store.consume('failure', 'registration')).toBe(true);
});
