import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drive_sessions'),
    env.DB.prepare('DELETE FROM drive_credentials'),
    env.DB.prepare('DELETE FROM drive_principals'),
    env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('owner', 'owner', 'active'), ('member', 'member', 'active'), ('disabled', 'member', 'revoked')"),
  ]);
  return new Sessions(env.DB);
}

it('stores only a hash and resolves live membership across service restart', async () => {
  const sessions = await setup();
  const before = Date.now();
  const { token, expiresAt } = await sessions.issue('owner');
  const other = await sessions.issue('member');
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(token).not.toBe(other.token);
  expect(expiresAt).toBeGreaterThan(before);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + 12 * 60 * 60 * 1000);
  const rows = await env.DB.prepare('SELECT token_hash, principal_id FROM drive_sessions').all();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  expect(rows.results).toContainEqual({ token_hash: hash, principal_id: 'owner' });
  expect(JSON.stringify(rows.results)).not.toContain(token);
  const restarted = new Sessions(env.DB);
  expect(await restarted.lookup(token)).toEqual({ id: 'owner', role: 'owner' });
  expect(await restarted.lookup(other.token)).toEqual({ id: 'member', role: 'member' });
  await expect(restarted.issue('disabled')).rejects.toThrow('Session unavailable');
  await expect(restarted.issue('missing')).rejects.toThrow('Session unavailable');
  expect(await restarted.lookup('invalid')).toBeNull();
  expect(await restarted.lookup('A'.repeat(43))).toBeNull();
});

it('rejects expiry and revocation without affecting another member', async () => {
  const sessions = await setup();
  const expired = await sessions.issue('owner');
  const revoked = await sessions.issue('member');
  const unaffected = await sessions.issue('member');
  await env.DB.prepare("UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = 'owner'").run();
  expect(await sessions.lookup(expired.token)).toBeNull();
  await sessions.revoke(revoked.token);
  await sessions.revoke(revoked.token);
  expect(await sessions.lookup(revoked.token)).toBeNull();
  expect(await sessions.lookup(unaffected.token)).toEqual({ id: 'member', role: 'member' });
});

it('deletes expiry at the database clock boundary but not after it', async () => {
  await setup();
  await env.DB.prepare(`INSERT INTO drive_sessions VALUES
    (?, 'owner', 999), (?, 'owner', 1000), (?, 'owner', 1001)`)
    .bind('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)).run();
  // Pin only the database clock expression so the actual cleanup SQL runs on D1.
  const clock = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
  const sessions = new Sessions({ prepare: (sql) => {
    expect(sql).toContain(clock);
    return env.DB.prepare(sql.replace(clock, '1000'));
  } });
  expect(await sessions.cleanupExpired()).toBe(2);
  const rows = await env.DB.prepare('SELECT expires_at FROM drive_sessions').all();
  expect(rows.results).toEqual([{ expires_at: 1001 }]);
});

it('cleans bounded batches of expired sessions without removing live sessions', async () => {
  const sessions = await setup();
  const live = await sessions.issue('member');
  // Includes an expiry at the database clock boundary and a clearly expired backlog.
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 205)
    INSERT INTO drive_sessions (token_hash, principal_id, expires_at)
    SELECT printf('%064x', x), 'owner', CASE WHEN x = 205
      THEN CAST(unixepoch('subsec') * 1000 AS INTEGER) ELSE 1 END FROM n`).run();
  expect(await sessions.cleanupExpired()).toBe(100);
  expect(await sessions.cleanupExpired()).toBe(100);
  expect(await sessions.cleanupExpired()).toBe(5);
  expect(await sessions.cleanupExpired()).toBe(0);
  expect(await sessions.lookup(live.token)).toEqual({ id: 'member', role: 'member' });
});

it('keeps concurrent cleanup calls bounded and preserves live membership checks', async () => {
  const sessions = await setup();
  const live = await sessions.issue('member');
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 150)
    INSERT INTO drive_sessions (token_hash, principal_id, expires_at)
    SELECT printf('%064x', x), 'owner', 1 FROM n`).run();
  const counts = await Promise.all([sessions.cleanupExpired(), sessions.cleanupExpired()]);
  expect(counts.every((count) => count <= 100)).toBe(true);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(150);
  expect(await sessions.lookup(live.token)).toEqual({ id: 'member', role: 'member' });
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'").run();
  expect(await sessions.lookup(live.token)).toBeNull();
});

it('permanently invalidates sessions when a member is disabled and later re-enabled', async () => {
  const sessions = await setup();
  const old = await sessions.issue('member');
  const owner = await sessions.issue('owner');
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'member'").run();
  expect(await sessions.lookup(old.token)).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'member'").run();
  expect(await sessions.lookup(old.token)).toBeNull();
  expect(await sessions.lookup(owner.token)).toEqual({ id: 'owner', role: 'owner' });
  const fresh = await sessions.issue('member');
  expect(await sessions.lookup(fresh.token)).toEqual({ id: 'member', role: 'member' });
});
