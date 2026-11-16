import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { BoundCeremonies } from '../../drive/src/lib/server/identity/bound-ceremony.ts';
import { fixture, rpID, origin } from '../../drive/tests/ceremony-fixture.ts';

it('binds real verification to context and purpose, and consumes once', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const ceremonies = new BoundCeremonies(env.DB, rpID, origin);
  const challenge = await ceremonies.issue('alice', 'authentication');
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const signed = await fixture('authentication', { challenge });
  await expect(ceremonies.authentication('bob', challenge, signed.authentication, signed.credential)).rejects.toThrow();
  await expect(ceremonies.registration('alice', challenge, signed.registration)).rejects.toThrow();
  expect((await ceremonies.authentication('alice', challenge, signed.authentication, signed.credential)).verified).toBe(true);
  await expect(ceremonies.authentication('alice', challenge, signed.authentication, signed.credential)).rejects.toThrow();
  const registrationChallenge = await ceremonies.issue('alice', 'registration');
  const registration = await fixture('registration', { challenge: registrationChallenge });
  expect((await ceremonies.registration('alice', registrationChallenge, registration.registration)).verified).toBe(true);
});

it('fails closed for races, expiration, replacement and verifier failure', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const ceremonies = new BoundCeremonies(env.DB, rpID, origin);
  const challenge = await ceremonies.issue('race', 'authentication');
  const signed = await fixture('authentication', { challenge });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
    ceremonies.authentication('race', challenge, signed.authentication, signed.credential)));
  expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
  const badChallenge = await ceremonies.issue('bad', 'authentication');
  const bad = await fixture('authentication', { challenge: badChallenge, badSignature: true });
  expect((await ceremonies.authentication('bad', badChallenge, bad.authentication, bad.credential)).verified).toBe(false);
  const good = await fixture('authentication', { challenge: badChallenge });
  await expect(ceremonies.authentication('bad', badChallenge, good.authentication, good.credential)).rejects.toThrow();
  const expired = await ceremonies.issue('expired', 'authentication');
  await env.DB.prepare('UPDATE drive_bound_ceremonies SET expires_at = 1 WHERE context = ?').bind('expired').run();
  await expect(ceremonies.authentication('expired', expired, signed.authentication, signed.credential)).rejects.toThrow();
  const old = await ceremonies.issue('replace', 'authentication');
  const fresh = await ceremonies.issue('replace', 'authentication');
  expect(fresh).not.toBe(old);
  await expect(ceremonies.authentication('replace', old, signed.authentication, signed.credential)).rejects.toThrow();
  expect((await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE context = ?').bind('replace').first()).challenge).toBe(fresh);
});

it('bounds context, lifetime, and total retained rows', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const ceremonies = new BoundCeremonies(env.DB, rpID, origin);
  await expect(ceremonies.issue('', 'registration')).rejects.toThrow();
  await expect(ceremonies.issue('x'.repeat(257), 'registration')).rejects.toThrow();
  await expect(ceremonies.issue('alice', 'other')).rejects.toThrow();
  await ceremonies.issue('bounded', 'registration');
  const row = await env.DB.prepare("SELECT expires_at - CAST(unixepoch('subsec') * 1000 AS INTEGER) AS remaining FROM drive_bound_ceremonies WHERE context = 'bounded'").first();
  expect(row.remaining).toBeGreaterThan(0);
  expect(row.remaining).toBeLessThanOrEqual(300000);
  await env.DB.exec("DELETE FROM drive_bound_ceremonies");
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1024)
    INSERT INTO drive_bound_ceremonies SELECT printf('ctx%d', x), 'registration', printf('challenge%d', x), 9999999999999 FROM n`).run();
  await expect(ceremonies.issue('overflow', 'registration')).rejects.toThrow('capacity');
  await expect(ceremonies.issue('ctx1', 'registration')).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies').first()).n).toBe(1024);
  await env.DB.exec("UPDATE drive_bound_ceremonies SET expires_at = 1 WHERE context = 'ctx2'");
  await expect(ceremonies.issue('overflow', 'registration')).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
});
