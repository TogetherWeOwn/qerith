import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { RecoveryTokens } from '../../drive/src/lib/server/identity/recovery.ts';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec('DELETE FROM drive_recovery_tokens; DELETE FROM drive_sessions; DELETE FROM drive_principals;');
});

it('issues bounded hashed tokens only for an active owner session and target', async () => {
  await env.DB.exec("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active'), ('revoked', 'member', 'revoked')");
  const sessions = new Sessions(env.DB);
  const owner = (await sessions.issue('owner')).token;
  const member = (await sessions.issue('member')).token;
  const recovery = new RecoveryTokens(env.DB);
  for (const [actor, target] of [[member, 'member'], ['missing', 'member'], [owner, 'missing'], [owner, 'revoked']]) {
    await expect(recovery.issue(actor, target)).rejects.toThrow('Recovery unavailable');
  }
  const before = Date.now();
  const issued = await recovery.issue(owner, 'member');
  expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(issued.expiresAt).toBeGreaterThanOrEqual(before + 86400000);
  expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 86400000);
  const row = await env.DB.prepare('SELECT * FROM drive_recovery_tokens WHERE id = ?').bind(issued.id).first();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(issued.token))),
    byte => byte.toString(16).padStart(2, '0')).join('');
  expect(row.principal_id).toBe('member');
  expect(row.token_hash).toBe(digest);
  expect(JSON.stringify(row)).not.toContain(issued.token);
  await expect(recovery.cancel(member, issued.id)).rejects.toThrow();
  await recovery.cancel(owner, issued.id);
  await expect(recovery.cancel(owner, issued.id)).rejects.toThrow();
  expect((await env.DB.prepare('SELECT cancelled_at FROM drive_recovery_tokens WHERE id = ?').bind(issued.id).first()).cancelled_at).toBeGreaterThan(0);
  const expired = await recovery.issue(owner, 'member');
  expect(expired.token).not.toBe(issued.token);
  await env.DB.prepare('UPDATE drive_recovery_tokens SET expires_at = 1 WHERE id = ?').bind(expired.id).run();
  await expect(recovery.cancel(owner, expired.id)).rejects.toThrow();
  const redeemed = await recovery.issue(owner, 'member');
  await env.DB.prepare('UPDATE drive_recovery_tokens SET redeemed_at = 1 WHERE id = ?').bind(redeemed.id).run();
  await expect(recovery.cancel(owner, redeemed.id)).rejects.toThrow();
});

it('cancels tokens when an owner is deleted and permits target deletion', async () => {
  await env.DB.exec("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active')");
  const owner = (await new Sessions(env.DB).issue('owner')).token;
  const recovery = new RecoveryTokens(env.DB);
  const token = await recovery.issue(owner, 'member');
  await env.DB.exec("DELETE FROM drive_principals WHERE id = 'owner'");
  expect((await env.DB.prepare('SELECT cancelled_at FROM drive_recovery_tokens WHERE id = ?').bind(token.id).first()).cancelled_at).toBeGreaterThan(0);
  await env.DB.exec("DELETE FROM drive_principals WHERE id = 'member'");
  expect(await env.DB.prepare('SELECT id FROM drive_recovery_tokens WHERE id = ?').bind(token.id).first()).toBeNull();
});

it('rejects a revoked or expired owner session at mutation time', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active')");
  const sessions = new Sessions(env.DB);
  const recovery = new RecoveryTokens(env.DB);
  const owner = (await sessions.issue('owner')).token;
  const issued = await recovery.issue(owner, 'member');
  expect(await sessions.lookup(owner)).not.toBeNull();
  await sessions.revoke(owner);
  await expect(recovery.issue(owner, 'member')).rejects.toThrow('Recovery unavailable');
  await expect(recovery.cancel(owner, issued.id)).rejects.toThrow('Recovery unavailable');
  const expired = (await sessions.issue('owner')).token;
  await env.DB.exec('UPDATE drive_sessions SET expires_at = 1');
  await expect(recovery.issue(expired, 'member')).rejects.toThrow('Recovery unavailable');
  await expect(recovery.cancel(expired, issued.id)).rejects.toThrow('Recovery unavailable');
  const fresh = (await sessions.issue('owner')).token;
  await recovery.cancel(fresh, issued.id);
});

it('invalidates outstanding tokens across target and owner membership changes', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active')");
  const sessions = new Sessions(env.DB);
  const owner = (await sessions.issue('owner')).token;
  const recovery = new RecoveryTokens(env.DB);
  const memberToken = await recovery.issue(owner, 'member');
  const ownerToken = await recovery.issue(owner, 'owner');
  await env.DB.exec("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'; UPDATE drive_principals SET status = 'active' WHERE id = 'member'");
  await expect(recovery.cancel(owner, memberToken.id)).rejects.toThrow();
  expect((await env.DB.prepare('SELECT cancelled_at FROM drive_recovery_tokens WHERE id = ?').bind(ownerToken.id).first()).cancelled_at).toBeNull();
  await env.DB.exec("UPDATE drive_principals SET role = 'member' WHERE id = 'owner'; UPDATE drive_principals SET role = 'owner' WHERE id = 'member'");
  await expect(recovery.cancel(owner, ownerToken.id)).rejects.toThrow();
  const newOwner = (await sessions.issue('member')).token;
  expect((await env.DB.prepare('SELECT cancelled_at FROM drive_recovery_tokens WHERE id = ?').bind(ownerToken.id).first()).cancelled_at).toBeGreaterThan(0);
  const next = await recovery.issue(newOwner, 'owner');
  await env.DB.exec("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'; UPDATE drive_principals SET status = 'active' WHERE id = 'member'");
  await expect(recovery.cancel(newOwner, next.id)).rejects.toThrow();
  const restored = (await sessions.issue('member')).token;
  await expect(recovery.cancel(restored, next.id)).rejects.toThrow();
});
