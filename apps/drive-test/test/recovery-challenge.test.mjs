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
    INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active')`);
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
