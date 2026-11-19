import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { RecoveryChallenges } from '../../drive/src/lib/server/identity/recovery-challenge.ts';
import { RecoveryTokens } from '../../drive/src/lib/server/identity/recovery.ts';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';

let owner, recovery, challenges;
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec(`DELETE FROM drive_bound_ceremonies; DELETE FROM drive_recovery_tokens;
    DELETE FROM drive_sessions; DELETE FROM drive_principals;
    INSERT INTO drive_principals (id, role, status) VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active')`);
  owner = (await new Sessions(env.DB).issue('owner')).token;
  recovery = new RecoveryTokens(env.DB);
  challenges = new RecoveryChallenges(env.DB);
});

it('binds and replaces challenges without redeeming or persisting the bearer', async () => {
  const issued = await recovery.issue(owner, 'member');
  const first = await challenges.issue(issued.token);
  const second = await challenges.issue(issued.token);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second).not.toBe(first);
  const rows = await env.DB.prepare('SELECT * FROM drive_bound_ceremonies').all();
  expect(rows.results).toHaveLength(1);
  expect(rows.results[0].challenge).toBe(second);
  expect(rows.results[0].purpose).toBe('registration');
  expect(JSON.stringify(rows.results)).not.toContain(issued.token);
  expect((await env.DB.prepare('SELECT redeemed_at FROM drive_recovery_tokens WHERE id = ?').bind(issued.id).first()).redeemed_at).toBeNull();
});

it('releases cancelled slots without deleting unrelated or active ceremonies', async () => {
  const cancelled = await recovery.issue(owner, 'member');
  const active = await recovery.issue(owner, 'member');
  const cancelledChallenge = await challenges.issue(cancelled.token);
  const activeChallenge = await challenges.issue(active.token);
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1022)
    INSERT INTO drive_bound_ceremonies (context, purpose, challenge, expires_at) SELECT printf('other%d', x), 'registration', printf('other%d', x), 9999999999999 FROM n`).run();
  const next = await recovery.issue(owner, 'member');
  await expect(challenges.issue(next.token)).rejects.toThrow('Recovery unavailable');
  await recovery.cancel(owner, cancelled.id);
  expect(await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE challenge = ?').bind(cancelledChallenge).first()).toBeNull();
  expect(await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE challenge = ?').bind(activeChallenge).first()).not.toBeNull();
  await expect(challenges.issue(next.token)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies').first()).n).toBe(1024);
});

it('rolls back challenge removal when token cancellation fails in a batch', async () => {
  const issued = await recovery.issue(owner, 'member');
  const challenge = await challenges.issue(issued.token);
  await expect(env.DB.batch([
    env.DB.prepare('UPDATE drive_recovery_tokens SET cancelled_at = 1 WHERE id = ?').bind(issued.id),
    env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('member', 'member', 'active')"),
  ])).rejects.toThrow();
  expect((await env.DB.prepare('SELECT cancelled_at FROM drive_recovery_tokens WHERE id = ?').bind(issued.id).first()).cancelled_at).toBeNull();
  expect(await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE challenge = ?').bind(challenge).first()).not.toBeNull();
});

it('removes bound challenges when tokens are redeemed, deleted or revoked', async () => {
  for (const state of ['redeemed', 'deleted', 'revoked']) {
    const issued = await recovery.issue(owner, 'member');
    const challenge = await challenges.issue(issued.token);
    if (state === 'redeemed') await env.DB.prepare('UPDATE drive_recovery_tokens SET redeemed_at = 1 WHERE id = ?').bind(issued.id).run();
    if (state === 'deleted') await env.DB.prepare('DELETE FROM drive_recovery_tokens WHERE id = ?').bind(issued.id).run();
    if (state === 'revoked') await env.DB.exec("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'");
    expect(await env.DB.prepare('SELECT challenge FROM drive_bound_ceremonies WHERE challenge = ?').bind(challenge).first()).toBeNull();
  }
});

it('rejects invalid, cancelled, expired, redeemed and revoked recovery tokens', async () => {
  await expect(challenges.issue('invalid')).rejects.toThrow('Recovery unavailable');
  for (const state of ['cancelled', 'expired', 'redeemed', 'revoked']) {
    const issued = await recovery.issue(owner, 'member');
    if (state === 'cancelled') await recovery.cancel(owner, issued.id);
    if (state === 'expired') await env.DB.prepare('UPDATE drive_recovery_tokens SET expires_at = 1 WHERE id = ?').bind(issued.id).run();
    if (state === 'redeemed') await env.DB.prepare('UPDATE drive_recovery_tokens SET redeemed_at = 1 WHERE id = ?').bind(issued.id).run();
    if (state === 'revoked') await env.DB.exec("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'");
    await expect(challenges.issue(issued.token)).rejects.toThrow('Recovery unavailable');
  }
  expect((await env.DB.prepare('SELECT count(*) AS n FROM drive_bound_ceremonies').first()).n).toBe(0);
});
