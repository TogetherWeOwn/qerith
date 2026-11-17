import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { Invitations } from '../../drive/src/lib/server/identity/invitations.ts';

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec('DELETE FROM drive_invitations');
  await env.DB.exec('DELETE FROM drive_principals');
  await env.DB.exec("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active')");
});

it('issues hashed tokens only for a live owner and persists cancellation', async () => {
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
  await service.cancel('owner', expired.id);
});

it('limits presentation to valid tokens and listing to active owners', async () => {
  const service = new Invitations(env.DB);
  expect(await service.list('owner')).toEqual([]);
  for (const actor of ['member', 'missing']) await expect(service.list(actor)).rejects.toThrow('Invitation unavailable');
  for (const metadata of [{ displayName: 'x'.repeat(65) }, { note: 'x'.repeat(141) }, { note: '\0' }]) {
    await expect(service.issue('owner', metadata)).rejects.toThrow();
  }
  const invite = await service.issue('owner', { displayName: 'Pell', note: '😀'.repeat(140) });
  const empty = await service.issue('owner');
  expect(await service.present(invite.token)).toEqual({ displayName: 'Pell', note: '😀'.repeat(140) });
  expect(await service.present(empty.token)).toEqual({ displayName: null, note: null });
  const listed = await service.list('owner');
  expect(listed).toHaveLength(2);
  expect(listed.find(row => row.id === invite.id)).toMatchObject({ displayName: 'Pell', note: '😀'.repeat(140), expiresAt: invite.expiresAt });
  expect(listed.find(row => row.id === invite.id).createdAt).toBeGreaterThan(0);
  expect(JSON.stringify(listed)).not.toContain(invite.token);
  expect(JSON.stringify(listed)).not.toContain('token_hash');
  await service.cancel('owner', invite.id);
  await expect(service.present(invite.token)).rejects.toThrow('Invitation unavailable');
  await expect(service.present('invalid')).rejects.toThrow('Invitation unavailable');
  await expect(service.present('A'.repeat(43))).rejects.toThrow('Invitation unavailable');
  await env.DB.prepare('UPDATE drive_invitations SET expires_at = 1 WHERE id = ?').bind(empty.id).run();
  await expect(service.present(empty.token)).rejects.toThrow('Invitation unavailable');
  expect((await service.list('owner')).map(row => row.id)).toEqual([empty.id]);
  const redeemed = await service.issue('owner');
  await env.DB.prepare('UPDATE drive_invitations SET redeemed_at = 1 WHERE id = ?').bind(redeemed.id).run();
  await expect(service.present(redeemed.token)).rejects.toThrow('Invitation unavailable');
  expect((await service.list('owner')).map(row => row.id)).toEqual([empty.id]);
  await env.DB.exec("UPDATE drive_principals SET status = 'revoked' WHERE id = 'owner'");
  await expect(service.list('owner')).rejects.toThrow('Invitation unavailable');
});
