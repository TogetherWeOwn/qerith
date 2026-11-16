import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { RecoveryTokens } from '../../drive/src/lib/server/identity/recovery.ts';

it('issues bounded hashed tokens only for an active owner and target', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active'), ('revoked', 'member', 'revoked')");
  const recovery = new RecoveryTokens(env.DB);
  for (const [actor, target] of [['member', 'member'], ['missing', 'member'], ['owner', 'missing'], ['owner', 'revoked']]) {
    await expect(recovery.issue(actor, target)).rejects.toThrow('Recovery unavailable');
  }
  const before = Date.now();
  const issued = await recovery.issue('owner', 'member');
  expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(issued.expiresAt).toBeGreaterThanOrEqual(before + 86400000);
  expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 86400000);
  const row = await env.DB.prepare('SELECT * FROM drive_recovery_tokens WHERE id = ?').bind(issued.id).first();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(issued.token))),
    byte => byte.toString(16).padStart(2, '0')).join('');
  expect(row.principal_id).toBe('member');
  expect(row.token_hash).toBe(digest);
  expect(JSON.stringify(row)).not.toContain(issued.token);
  await expect(recovery.cancel('member', issued.id)).rejects.toThrow();
  await recovery.cancel('owner', issued.id);
  await expect(recovery.cancel('owner', issued.id)).rejects.toThrow();
  expect((await env.DB.prepare('SELECT cancelled_at FROM drive_recovery_tokens WHERE id = ?').bind(issued.id).first()).cancelled_at).toBeGreaterThan(0);
  const expired = await recovery.issue('owner', 'member');
  expect(expired.token).not.toBe(issued.token);
  await env.DB.prepare('UPDATE drive_recovery_tokens SET expires_at = 1 WHERE id = ?').bind(expired.id).run();
  await expect(recovery.cancel('owner', expired.id)).rejects.toThrow();
  const redeemed = await recovery.issue('owner', 'member');
  await env.DB.prepare('UPDATE drive_recovery_tokens SET redeemed_at = 1 WHERE id = ?').bind(redeemed.id).run();
  await expect(recovery.cancel('owner', redeemed.id)).rejects.toThrow();
});

it('invalidates outstanding tokens across target and owner membership changes', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active')");
  const recovery = new RecoveryTokens(env.DB);
  const memberToken = await recovery.issue('owner', 'member');
  const ownerToken = await recovery.issue('owner', 'owner');
  await env.DB.exec("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'; UPDATE drive_principals SET status = 'active' WHERE id = 'member'");
  await expect(recovery.cancel('owner', memberToken.id)).rejects.toThrow();
  expect((await env.DB.prepare('SELECT cancelled_at FROM drive_recovery_tokens WHERE id = ?').bind(ownerToken.id).first()).cancelled_at).toBeNull();
  await env.DB.exec("UPDATE drive_principals SET status = 'revoked' WHERE id = 'owner'");
  await expect(recovery.issue('owner', 'member')).rejects.toThrow();
  await expect(recovery.cancel('owner', ownerToken.id)).rejects.toThrow();
  await env.DB.exec("UPDATE drive_principals SET status = 'active' WHERE id = 'owner'");
  await expect(recovery.cancel('owner', ownerToken.id)).rejects.toThrow();
});
