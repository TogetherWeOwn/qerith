import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { Sessions, tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';
import { EligibleRecipients } from '../../drive/src/lib/server/metadata/eligible-recipients.ts';
import { getEligibleRecipients } from '../../drive/src/lib/server/eligible-recipient-route.ts';
import { eligibleRecipientsRoute, privateRequests, sessionCookie } from '../../drive/src/lib/server/request-auth.ts';

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

const row = (recipientId, { displayName = null, direct = false, inheritedFrom = null } = {}) =>
  ({ recipientId, displayName, direct, inheritedFrom });

it('returns eligible names and root access to the entry owner in one primary statement', async () => {
  const { read, alice, admin, bob } = await setup();
  await env.DB.batch([
    env.DB.prepare("UPDATE drive_principals SET display_name = 'Bob' WHERE id = 'bob'"),
    env.DB.prepare("INSERT INTO drive_read_grants (entry_id, recipient_id) VALUES ('folder', 'bob')"),
  ]);
  const all = vi.fn(statement => statement.all());
  const withSession = vi.fn(constraint => {
    const db = env.DB.withSession(constraint);
    return { prepare: sql => ({ bind: (...values) => ({ all: () => all(db.prepare(sql).bind(...values)) }) }) };
  });
  expect(await new EligibleRecipients({ withSession }).listPage(alice.token, 'folder')).toEqual({
    recipients: [row('bob', { displayName: 'Bob', direct: true })], nextCursor: null,
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

it('reports direct and current same-owner folder grants independently on a nested entry', async () => {
  const { read, alice, bob } = await setup();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO drive_principals (id, role, status) VALUES
      ('carol', 'member', 'active'), ('dave', 'member', 'active'), ('eve', 'member', 'active')`),
    env.DB.prepare("UPDATE drive_entries SET name = '<Shared root>' WHERE id = 'folder'"),
    env.DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES
      ('inner', 'alice', 'folder', 'Shared parent', 'folder'),
      ('child', 'alice', 'inner', 'Nested target', 'folder'),
      ('unrelated', 'bob', NULL, 'Unrelated folder', 'folder')`),
    env.DB.prepare(`INSERT INTO drive_read_grants (entry_id, recipient_id) VALUES
      ('child', 'bob'), ('folder', 'carol'), ('child', 'dave'), ('folder', 'dave'), ('inner', 'dave'),
      ('unrelated', 'eve')`),
  ]);
  const list = () => read.listPage(alice.token, 'child');
  const expected = [row('bob', { direct: true }), row('carol', { inheritedFrom: '<Shared root>' }),
    row('dave', { direct: true, inheritedFrom: '<Shared root>' }), row('eve')];
  expect(await list()).toEqual({ recipients: expected, nextCursor: null });
  expect(await read.listPage(bob.token, 'child')).toBeNull(); // Read access is not ownership.
  await env.DB.prepare("DELETE FROM drive_read_grants WHERE entry_id = 'folder' AND recipient_id = 'dave'").run();
  expect(await list()).toEqual({ recipients: [expected[0], expected[1],
    row('dave', { direct: true, inheritedFrom: 'Shared parent' }), expected[3]], nextCursor: null });
  await env.DB.prepare("UPDATE drive_entries SET parent_id = NULL WHERE id = 'child'").run();
  expect(await list()).toEqual({ recipients: [expected[0], row('carol'), row('dave', { direct: true }), expected[3]], nextCursor: null });
});

it('pages by ID and rechecks membership and session on every request', async () => {
  const { read, sessions, alice } = await setup();
  const ids = Array.from({ length: 101 }, (_, i) => `recipient-${String(i).padStart(3, '0')}`);
  await env.DB.prepare("INSERT INTO drive_principals (id, role, status) SELECT value, 'member', 'active' FROM json_each(?)")
    .bind(JSON.stringify(ids)).run();
  const expected = ['bob', ...ids].map(recipientId => row(recipientId));
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

it('serves owned recipient pages as private JSON and denies stale or nonowner sessions', async () => {
  const { alice, admin, bob, sessions } = await setup();
  const origin = 'https://drive.example.test';
  const bindings = { DB: env.DB, DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' };
  const handle = privateRequests(bindings);
  const path = '/api/entries/folder/eligible-recipients';
  const ask = (session, url = path, beforeList) => handle({
    event: { request: new Request(origin + url, { headers: session ? { cookie: `${sessionCookie}=${session.token}` } : {} }),
      route: { id: eligibleRecipientsRoute }, locals: {} },
    resolve: async ({ request, locals }) => {
      await beforeList?.();
      return getEligibleRecipients(request, bindings, locals.driveSession?.token ?? null);
    },
  });
  const deny = async (pending, status) => {
    const response = await pending;
    expect([response.status, response.headers.get('cache-control'), await response.text()]).toEqual([status, 'private, no-store', '']);
  };
  const list = async (url = path) => {
    const response = await ask(alice, url);
    expect([response.status, response.headers.get('cache-control'), response.headers.get('access-control-allow-origin')])
      .toEqual([200, 'private, no-store', null]);
    expect(response.headers.get('content-type')).toMatch(/^application\/json\b/);
    return response.json();
  };
  await deny(ask(null), 401);
  await deny(ask(bob), 404);
  await deny(ask(admin), 404);
  await deny(ask(alice, path.replace('folder', 'missing')), 404);
  expect(await list(`${path}?cursor=z`)).toEqual({ recipients: [], nextCursor: null });

  const displayName = '<b>Bob & friends</b>';
  const ids = Array.from({ length: 100 }, (_, i) => `recipient / ${String(i).padStart(3, '0')}`);
  const inheritedFrom = 'Shared parent';
  await env.DB.batch([
    env.DB.prepare("UPDATE drive_principals SET display_name = ? WHERE id = 'bob'").bind(displayName),
    env.DB.prepare("INSERT INTO drive_principals (id, role, status) SELECT value, 'member', 'active' FROM json_each(?)").bind(JSON.stringify(ids)),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('parent', 'alice', ?, 'folder')").bind(inheritedFrom),
    env.DB.prepare("UPDATE drive_entries SET parent_id = 'parent' WHERE id = 'folder'"),
    env.DB.prepare("INSERT INTO drive_read_grants (entry_id, recipient_id) VALUES ('folder', 'bob'), ('parent', ?)").bind(ids[99]),
  ]);
  const nextCursor = ids[98];
  expect(await list()).toEqual({ recipients: [row('bob', { displayName, direct: true }), ...ids.slice(0, 99).map(id => row(id))], nextCursor });
  const next = `${path}?cursor=${encodeURIComponent(nextCursor)}`;
  expect(await list(next)).toEqual({ recipients: [row(ids[99], { inheritedFrom })], nextCursor: null });
  await deny(ask(alice, next, () => sessions.revoke(alice.token)), 404); // Revoked after the hook lookup.
  await deny(ask(alice, next), 401);
});
