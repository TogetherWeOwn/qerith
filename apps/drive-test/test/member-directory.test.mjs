import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { MemberDirectory } from '../../drive/src/lib/server/identity/member-directory.ts';
import { Sessions, tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drive_entries'),
    env.DB.prepare('DELETE FROM drive_principals'),
    env.DB.prepare(`INSERT INTO drive_principals (id, role, status) VALUES
      ('admin', 'owner', 'active'), ('alice', 'member', 'active')`),
  ]);
  const sessions = new Sessions(env.DB);
  return { directory: new MemberDirectory(env.DB), sessions, admin: await sessions.issue('admin') };
}

it('projects only status, identity and exact file usage, including revoked members', async () => {
  const { directory, admin } = await setup();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('bob', 'member', 'active')"),
    env.DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes) VALUES
      ('a', 'bob', 'private name', 'file', 'private-key', 9007199254740991),
      ('b', 'bob', 'other name', 'file', 'other-key', 9007199254740991),
      ('c', 'alice', 'folder', 'folder', NULL, NULL), ('d', 'admin', 'file', 'file', 'admin-key', 17)`),
    env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'bob'"),
  ]);
  const members = [
    { id: 'admin', role: 'owner', status: 'active', usageBytes: '17' },
    { id: 'alice', role: 'member', status: 'active', usageBytes: '0' },
    { id: 'bob', role: 'member', status: 'revoked', usageBytes: '18014398509481982' },
  ];
  expect(await directory.listPage(admin.token)).toEqual({ members, nextCursor: null });
  await env.DB.prepare("DELETE FROM drive_entries WHERE owner_id = 'bob'").run();
  members[2].usageBytes = '0';
  expect(await directory.listPage(admin.token)).toEqual({ members, nextCursor: null });
});

it('reads one primary statement and distinguishes authorized empty from denial', async () => {
  const { directory, sessions, admin } = await setup();
  const withSession = vi.fn(constraint => {
    const db = env.DB.withSession(constraint);
    return { prepare: prepare.mockImplementation(sql => db.prepare(sql)) };
  });
  const prepare = vi.fn();
  const read = new MemberDirectory({ withSession });
  expect(await read.listPage(admin.token, 'z')).toEqual({ members: [], nextCursor: null });
  expect(withSession.mock.calls).toEqual([['first-primary']]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(await directory.listPage((await sessions.issue('alice')).token)).toBeNull();
  expect(await directory.listPage('admin')).toBeNull();
  await sessions.revoke(admin.token);
  expect(await directory.listPage(admin.token, 'z')).toBeNull();
  const expired = await sessions.issue('admin');
  await env.DB.prepare('UPDATE drive_sessions SET expires_at = 1 WHERE token_hash = ?')
    .bind(await tokenHash(expired.token)).run();
  expect(await directory.listPage(expired.token)).toBeNull();
});

it('bounds pages by ID and reauthorizes even after the cursor row disappears', async () => {
  const { directory, admin } = await setup();
  const ids = Array.from({ length: 101 }, (_, i) => `member-${String(i).padStart(3, '0')}`);
  await env.DB.prepare("INSERT INTO drive_principals (id, role, status) SELECT value, 'member', 'active' FROM json_each(?)")
    .bind(JSON.stringify([...ids].reverse())).run();
  const expected = ['admin', 'alice', ...ids];
  const first = await directory.listPage(admin.token);
  expect(first.members.map(({ id }) => id)).toEqual(expected.slice(0, 100));
  expect(first.nextCursor).toBe(expected[99]);
  await env.DB.prepare('DELETE FROM drive_principals WHERE id = ?').bind(first.nextCursor).run();
  const last = await directory.listPage(admin.token, first.nextCursor);
  expect(last.members.map(({ id }) => id)).toEqual(expected.slice(100));
  expect(last.nextCursor).toBeNull();

  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'admin'").run();
  // Restore the fixture session to prove an unexpired row alone is insufficient.
  await env.DB.prepare("INSERT INTO drive_sessions VALUES (?, 'admin', ?)")
    .bind(await tokenHash(admin.token), admin.expiresAt).run();
  expect(await directory.listPage(admin.token, first.nextCursor)).toBeNull();
});
