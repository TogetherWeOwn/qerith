import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { Sessions, tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';
import { EligibleRecipients } from '../../drive/src/lib/server/metadata/eligible-recipients.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drive_read_grants'),
    env.DB.prepare('DELETE FROM drive_entries'),
    env.DB.prepare('DELETE FROM drive_sessions'),
    env.DB.prepare('DELETE FROM drive_credentials'),
    env.DB.prepare('DELETE FROM drive_principals'),
    env.DB.prepare(`INSERT INTO drive_principals (id, role, status) VALUES
      ('admin', 'owner', 'active'), ('alice', 'member', 'active'),
      ('bob', 'member', 'active'), ('disabled', 'member', 'revoked')`),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('folder', 'alice', 'folder', 'folder')"),
  ]);
  const sessions = new Sessions(env.DB);
  return { read: new EligibleRecipients(env.DB), sessions,
    alice: await sessions.issue('alice'), admin: await sessions.issue('admin'), bob: await sessions.issue('bob') };
}

it('returns only active member IDs and names to the entry owner in one primary statement', async () => {
  const { read, alice, admin, bob } = await setup();
  await env.DB.prepare("UPDATE drive_principals SET display_name = 'Bob' WHERE id = 'bob'").run();
  const all = vi.fn(statement => statement.all());
  const withSession = vi.fn(constraint => {
    const db = env.DB.withSession(constraint);
    return { prepare: sql => ({ bind: (...values) => ({ all: () => all(db.prepare(sql).bind(...values)) }) }) };
  });
  expect(await new EligibleRecipients({ withSession }).listPage(alice.token, 'folder')).toEqual({
    recipients: [{ recipientId: 'bob', displayName: 'Bob' }], nextCursor: null,
  });
  expect(withSession.mock.calls).toEqual([['first-primary']]);
  expect(all).toHaveBeenCalledTimes(1);
  expect(await read.listPage(admin.token, 'folder')).toBeNull();
  expect(await read.listPage(bob.token, 'folder')).toBeNull();
  expect(await read.listPage(alice.token, 'missing')).toBeNull();
  expect(await read.listPage('invalid', 'folder')).toBeNull();
  expect(await read.listPage(alice.token, 'folder', 'z')).toEqual({ recipients: [], nextCursor: null });
  await expect(read.listPage(alice.token, 'folder', 'a'.repeat(513))).rejects.toThrow('Invalid recipient cursor');
});

it('pages by ID and rechecks membership and session on every request', async () => {
  const { read, sessions, alice } = await setup();
  const ids = Array.from({ length: 101 }, (_, i) => `recipient-${String(i).padStart(3, '0')}`);
  await env.DB.prepare("INSERT INTO drive_principals (id, role, status) SELECT value, 'member', 'active' FROM json_each(?)")
    .bind(JSON.stringify(ids)).run();
  const expected = ['bob', ...ids].map(recipientId => ({ recipientId, displayName: null }));
  const first = await read.listPage(alice.token, 'folder');
  expect(first).toEqual({ recipients: expected.slice(0, 100), nextCursor: expected[99].recipientId });
  const last = { recipients: expected.slice(100), nextCursor: null };
  expect(await read.listPage(alice.token, 'folder', first.nextCursor)).toEqual(last);
  await env.DB.prepare('DELETE FROM drive_principals WHERE id = ?').bind(first.nextCursor).run();
  expect(await read.listPage(alice.token, 'folder', first.nextCursor)).toEqual(last);
  await sessions.revoke(alice.token);
  expect(await read.listPage(alice.token, 'folder', first.nextCursor)).toBeNull();
  const expired = await sessions.issue('alice');
  await env.DB.prepare('UPDATE drive_sessions SET expires_at = 1 WHERE token_hash = ?')
    .bind(await tokenHash(expired.token)).run();
  expect(await read.listPage(expired.token, 'folder')).toBeNull();
  const live = await sessions.issue('alice');
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  await env.DB.prepare("INSERT INTO drive_sessions VALUES (?, 'alice', ?)")
    .bind(await tokenHash(live.token), live.expiresAt).run();
  expect(await read.listPage(live.token, 'folder')).toBeNull();
});
