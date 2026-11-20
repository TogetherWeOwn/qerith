import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { Sessions, tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';
import { ReadGrants } from '../../drive/src/lib/server/metadata/read-grants.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drive_read_grants'),
    env.DB.prepare('DELETE FROM drive_entries'),
    env.DB.prepare('DELETE FROM drive_sessions'),
    env.DB.prepare('DELETE FROM drive_credentials'),
    env.DB.prepare('DELETE FROM drive_principals'),
    env.DB.prepare(`INSERT INTO drive_principals (id, role, status) VALUES
      ('admin', 'owner', 'active'), ('alice', 'member', 'active'), ('bob', 'member', 'active'),
      ('carol', 'member', 'active'), ('disabled', 'member', 'revoked')`),
    env.DB.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind) VALUES
      ('folder', 'alice', 'folder', 'folder'), ('admin-folder', 'admin', 'admin-folder', 'folder')`),
    env.DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
      VALUES ('file', 'alice', 'folder', 'file', 'file', 'key', 1)`),
  ]);
  const sessions = new Sessions(env.DB);
  const token = async id => (await sessions.issue(id)).token;
  return { grants: new ReadGrants(env.DB), sessions, alice: await token('alice'),
    admin: await token('admin'), bob: await token('bob'), carol: await token('carol') };
}

it('lists only explicit grant recipient IDs for the requested entry owner', async () => {
  const { grants, alice, admin, bob, carol } = await setup();
  expect(await grants.create(alice, 'folder', 'bob')).toBe(true);
  expect(await grants.create(alice, 'file', 'carol')).toBe(true);
  expect(await grants.listPage(alice, 'folder')).toEqual({ recipients: [{ recipientId: 'bob' }], nextCursor: null });
  expect(await grants.listPage(alice, 'file')).toEqual({ recipients: [{ recipientId: 'carol' }], nextCursor: null });
  expect(await grants.listPage(admin, 'admin-folder')).toEqual({ recipients: [], nextCursor: null });
  expect(await grants.listPage(admin, 'folder')).toBeNull();
  expect(await grants.listPage(bob, 'folder')).toBeNull();
  expect(await grants.listPage(carol, 'folder')).toBeNull();
  expect(await grants.listPage(alice, 'missing')).toBeNull();
  expect(await grants.listPage('alice', 'folder')).toBeNull();
});

it('authorizes and lists grants in one primary D1 statement', async () => {
  const { grants, alice } = await setup();
  expect(await grants.create(alice, 'folder', 'bob')).toBe(true);
  const all = vi.fn(statement => statement.all());
  const withSession = vi.fn(constraint => {
    const db = env.DB.withSession(constraint);
    return { prepare: sql => ({ bind: (...values) => ({ all: () => all(db.prepare(sql).bind(...values)) }) }) };
  });
  const read = new ReadGrants({ withSession });
  expect(await read.listPage(alice, 'folder')).toEqual({ recipients: [{ recipientId: 'bob' }], nextCursor: null });
  expect(withSession.mock.calls).toEqual([['first-primary']]);
  expect(all).toHaveBeenCalledTimes(1);
});

it('rechecks live sessions and memberships and reflects removed grants on the next read', async () => {
  const { grants, sessions, alice } = await setup();
  expect(await grants.create(alice, 'folder', 'bob')).toBe(true);
  expect(await grants.create(alice, 'folder', 'carol')).toBe(true);
  expect(await grants.listPage(alice, 'folder')).toEqual({
    recipients: [{ recipientId: 'bob' }, { recipientId: 'carol' }], nextCursor: null,
  });
  expect(await grants.revoke(alice, 'folder', 'bob')).toBe(true);
  expect(await grants.listPage(alice, 'folder')).toEqual({ recipients: [{ recipientId: 'carol' }], nextCursor: null });
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'carol'").run();
  expect(await grants.listPage(alice, 'folder')).toEqual({ recipients: [], nextCursor: null });

  await sessions.revoke(alice);
  expect(await grants.listPage(alice, 'folder')).toBeNull();
  const expired = (await sessions.issue('alice')).token;
  await env.DB.prepare("UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = 'alice'").run();
  expect(await grants.listPage(expired, 'folder')).toBeNull();
  const live = await sessions.issue('alice');
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  // Restore the live row only in the fixture to test membership separately from session cleanup.
  await env.DB.prepare("INSERT INTO drive_sessions VALUES (?, 'alice', ?)")
    .bind(await tokenHash(live.token), live.expiresAt).run();
  expect(await grants.listPage(live.token, 'folder')).toBeNull();
});

it('omits persisted rows for ineligible recipients', async () => {
  const { grants, alice } = await setup();
  await env.DB.prepare(`INSERT INTO drive_read_grants VALUES
    ('folder', 'admin'), ('folder', 'alice'), ('folder', 'disabled'), ('folder', 'bob')`).run();
  expect(await grants.listPage(alice, 'folder')).toEqual({ recipients: [{ recipientId: 'bob' }], nextCursor: null });
});

it('seeks a bounded grant page even after the cursor grant is removed', async () => {
  const { grants, sessions, alice, admin } = await setup();
  const ids = Array.from({ length: 103 }, (_, i) => `recipient-${String(i).padStart(3, '0')}`);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO drive_principals (id, role, status) SELECT value, 'member', 'active' FROM json_each(?)")
      .bind(JSON.stringify([...ids].reverse())),
    env.DB.prepare("INSERT INTO drive_read_grants SELECT 'folder', value FROM json_each(?)")
      .bind(JSON.stringify([...ids].reverse())),
  ]);
  const recipients = ids.map(recipientId => ({ recipientId }));
  const page = await grants.listPage(alice, 'folder');
  expect(page).toEqual({ recipients: recipients.slice(0, 100), nextCursor: ids[99] });
  expect(await grants.listPage(admin, 'folder', page.nextCursor)).toBeNull();
  expect(await grants.listPage(alice, 'file', page.nextCursor)).toEqual({ recipients: [], nextCursor: null });
  const lastPage = { recipients: recipients.slice(100), nextCursor: null };
  expect(await grants.listPage(alice, 'folder', page.nextCursor)).toEqual(lastPage);
  expect(await grants.revoke(alice, 'folder', page.nextCursor)).toBe(true);
  expect(await grants.listPage(alice, 'folder', page.nextCursor)).toEqual(lastPage);
  await sessions.revoke(alice);
  expect(await grants.listPage(alice, 'folder', page.nextCursor)).toBeNull();
});
