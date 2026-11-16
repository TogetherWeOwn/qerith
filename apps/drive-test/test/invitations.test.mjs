import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Invitations } from '../../drive/src/lib/server/identity/invitations.ts';

it('issues hashed tokens only for a live owner and persists cancellation', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active')");
  const service = new Invitations(env.DB);
  for (const actor of ['missing', 'member']) await expect(service.issue(actor)).rejects.toThrow();
  const before = Date.now();
  const issued = await service.issue('owner');
  expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(issued.expiresAt).toBeGreaterThanOrEqual(before + 604800000);
  expect(issued.expiresAt).toBeLessThanOrEqual(Date.now() + 604800000);
  const row = await env.DB.prepare('SELECT * FROM drive_invitations WHERE id = ?').bind(issued.id).first();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(issued.token))),
    byte => byte.toString(16).padStart(2, '0')).join('');
  expect(row.token_hash).toBe(digest);
  expect(JSON.stringify(row)).not.toContain(issued.token);
  await expect(service.cancel('member', issued.id)).rejects.toThrow();
  await env.DB.exec("UPDATE drive_principals SET status = 'revoked' WHERE id = 'owner'");
  await expect(service.issue('owner')).rejects.toThrow();
  await expect(service.cancel('owner', issued.id)).rejects.toThrow();
  await env.DB.exec("UPDATE drive_principals SET status = 'active' WHERE id = 'owner'");
  await new Invitations(env.DB).cancel('owner', issued.id);
  expect((await env.DB.prepare('SELECT cancelled_at FROM drive_invitations WHERE id = ?').bind(issued.id).first()).cancelled_at).toBeGreaterThan(0);
  await expect(service.cancel('owner', issued.id)).rejects.toThrow();
  const expired = await service.issue('owner');
  expect(expired.token).not.toBe(issued.token);
  await env.DB.prepare('UPDATE drive_invitations SET expires_at = 1 WHERE id = ?').bind(expired.id).run();
  await expect(service.cancel('owner', expired.id)).rejects.toThrow();
});
