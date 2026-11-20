import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Sessions, tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';
import { listingRequest } from '../../drive/src/lib/server/listing-routes.ts';
import { ReadGrants } from '../../drive/src/lib/server/metadata/read-grants.ts';
import { createSharedReadAccess, ReadAccess } from '../../drive/src/lib/server/metadata/read-access.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drive_read_grants'),
    env.DB.prepare('DELETE FROM drive_entries'),
    env.DB.prepare('DELETE FROM drive_sessions'),
    env.DB.prepare('DELETE FROM drive_credentials'),
    env.DB.prepare('DELETE FROM drive_principals'),
    env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('owner', 'owner', 'active'), ('alice', 'member', 'active'), ('bob', 'member', 'active'), ('eve', 'member', 'active')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('root', 'alice', 'root', 'folder'), ('elsewhere', 'alice', 'elsewhere', 'folder'), ('other', 'eve', 'other', 'folder')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES ('nested', 'alice', 'root', 'nested', 'folder')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES ('file', 'alice', 'nested', 'file', 'file', 'secret-key', 7)"),
  ]);
  const sessions = new Sessions(env.DB);
  return { sessions, grants: new ReadGrants(env.DB), reads: new ReadAccess(env.DB),
    alice: (await sessions.issue('alice')).token, bob: (await sessions.issue('bob')).token,
    eve: (await sessions.issue('eve')).token };
}

async function httpListing(view, token, query = {}, status = 200) {
  const origin = 'https://drive.example.test';
  const request = new Request(`${origin}/api/${view}-listing?${new URLSearchParams(query)}`, {
    headers: token ? { cookie: `__Host-drive-session=${token}` } : {},
  });
  const response = await listingRequest(request, { DB: env.DB, DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1' });
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  if (status === 200) return response.json();
  expect(await response.text()).toBe('');
}

it('serves only safe folder rows to owners and authorized members', async () => {
  const { sessions, grants, alice, bob, eve } = await setup();
  const owner = (await sessions.issue('owner')).token;
  await env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('empty', 'owner', 'empty', 'folder')").run();
  const list = (token, folderId, status) => httpListing('folder', token, { folderId }, status);
  const page = { entries: [], total: 0, order: 'binary-name', direction: 'asc', nextCursor: null };
  expect(await list(owner, 'empty')).toEqual(page);
  expect(await list(alice, 'elsewhere')).toEqual(page);
  await list(alice, 'file', 404);
  await list(owner, 'nested', 404);
  await list(eve, 'nested', 404);
  await list(null, 'nested', 401);
  expect(await grants.create(alice, 'root', 'bob')).toBe(true);
  const expected = { ...page, entries: [{ id: 'file', name: 'file', kind: 'file' }], total: 1 };
  expect(await list(alice, 'nested')).toEqual(expected);
  expect(await list(bob, 'nested')).toEqual(expected);
  expect(await httpListing('shared', bob)).toEqual({ entries: [{ id: 'root', name: 'root', kind: 'folder' }], nextCursor: null });
  await httpListing('folder', bob, { folderId: 'nested', cursor: 'invalid' }, 400);
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'bob'").run();
  await list(bob, 'nested', 401);
  await httpListing('shared', bob, {}, 401);
});

it('bounds both HTTP pages and rechecks grants when a cursor is replayed', async () => {
  const { grants, alice, bob } = await setup();
  await seedListing(201, 'folder', { folderId: 'nested' });
  expect(await grants.create(alice, 'root', 'bob')).toBe(true);
  const folderId = 'nested';
  const first = await httpListing('folder', bob, { folderId, direction: 'desc' });
  expect(first.entries).toHaveLength(200);
  expect(first).toMatchObject({ total: 202, direction: 'desc' });
  const query = { folderId, direction: 'desc', cursor: first.nextCursor };
  const second = await httpListing('folder', bob, query);
  expect(second.entries).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  await httpListing('folder', bob, { ...query, folderId: 'root' }, 400);
  expect(await grants.revoke(alice, 'root', 'bob')).toBe(true);
  await httpListing('folder', bob, query, 404);

  const ids = Array.from({ length: 101 }, (_, i) => `item-${i}`).sort();
  await env.DB.batch(ids.map(id => env.DB.prepare("INSERT INTO drive_read_grants VALUES (?, 'bob')").bind(id)));
  const shared = await httpListing('shared', bob);
  expect(shared.entries.map(entry => entry.id)).toEqual(ids.slice(0, 100));
  expect(shared.nextCursor).toBe(ids[99]);
  const next = { cursor: shared.nextCursor };
  expect(await httpListing('shared', bob, next)).toEqual({ entries: [
    { id: ids[100], name: `item-${ids[100].slice(5).padStart(3, '0')}`, kind: 'folder' },
  ], nextCursor: null });
  expect(await grants.revoke(alice, ids[100], 'bob')).toBe(true);
  expect(await httpListing('shared', bob, next)).toEqual({ entries: [], nextCursor: null });
});

it('authorizes direct and inherited reads and lists without disclosing parents or owners', async () => {
  const { grants, reads, alice, bob, eve } = await setup();
  expect(await reads.get(alice, 'file')).toEqual({ id: 'file', name: 'file', kind: 'file' });
  expect(await reads.get(bob, 'file')).toBeNull();
  expect(await reads.list(bob, 'nested')).toBeNull();
  expect(await reads.get(bob, 'missing')).toBeNull();
  expect(await reads.get(eve, 'file')).toBeNull();
  expect(await grants.create(alice, 'root', 'bob')).toBe(true);
  expect(await reads.get(bob, 'file')).toEqual({ id: 'file', name: 'file', kind: 'file' });
  expect(await reads.list(bob, 'nested')).toEqual({ entries: [{ id: 'file', name: 'file', kind: 'file' }], nextCursor: null });
  expect(await reads.listPage(bob, 'nested')).toEqual({
    entries: [{ id: 'file', name: 'file', kind: 'file' }], total: 1, order: 'binary-name', direction: 'asc', nextCursor: null,
  });
  expect(await reads.list(bob, 'file')).toBeNull();
  expect(await reads.listPage(bob, 'file')).toBeNull();
  expect(await reads.get(bob, 'other')).toBeNull();
  expect(await grants.create(bob, 'file', 'eve')).toBe(false);
  expect(await grants.revoke(alice, 'root', 'bob')).toBe(true);
  expect(await reads.get(bob, 'file')).toBeNull();
  expect(await grants.create(alice, 'file', 'bob')).toBe(true);
  expect(await reads.get(bob, 'file')).not.toBeNull();
  expect(await reads.get(bob, 'nested')).toBeNull();
});

it('re-evaluates inheritance on additions, moves, session and membership changes', async () => {
  const { sessions, grants, reads, alice, bob } = await setup();
  await grants.create(alice, 'root', 'bob');
  await env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES ('new', 'alice', 'root', 'new', 'folder')").run();
  expect(await reads.list(bob, 'new')).toEqual({ entries: [], nextCursor: null });
  expect(await reads.listPage(bob, 'new')).toEqual({ entries: [], total: 0, order: 'binary-name', direction: 'asc', nextCursor: null });
  await env.DB.prepare("UPDATE drive_entries SET parent_id = 'elsewhere' WHERE id = 'nested'").run();
  expect(await reads.get(bob, 'file')).toBeNull();
  await env.DB.prepare("UPDATE drive_entries SET parent_id = 'root' WHERE id = 'nested'").run();
  expect(await reads.get(bob, 'file')).not.toBeNull();
  await sessions.revoke(bob);
  expect(await reads.list(bob, 'root')).toBeNull();
  const again = (await sessions.issue('bob')).token;
  await env.DB.prepare("UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = 'bob'").run();
  expect(await reads.get(again, 'file')).toBeNull();
  const current = (await sessions.issue('bob')).token;
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'bob'").run();
  expect(await reads.get(current, 'file')).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'bob'").run();
  const restored = (await sessions.issue('bob')).token;
  expect(await reads.get(restored, 'file')).toBeNull();
  await grants.create(alice, 'root', 'bob');
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  expect(await reads.get(restored, 'file')).toBeNull();
  expect(await reads.list(restored, 'root')).toBeNull();
});

it('paginates only entries in the currently authorized folder', async () => {
  const { grants, reads, alice, bob } = await setup();
  await grants.create(alice, 'root', 'bob');
  const inserts = Array.from({ length: 102 }, (_, i) => env.DB.prepare(
    'INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES (?, ?, ?, ?, ?)'
  ).bind(`item-${i}`, 'alice', 'root', `item-${String(i).padStart(3, '0')}`, 'folder'));
  await env.DB.batch(inserts);
  const first = await reads.list(bob, 'root');
  expect(first.entries).toHaveLength(100);
  expect(first.nextCursor).not.toBeNull();
  const second = await reads.list(bob, 'root', first.nextCursor);
  expect(second.entries).toHaveLength(3);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size).toBe(103);
  await grants.revoke(alice, 'root', 'bob');
  expect(await reads.list(bob, 'root', first.nextCursor)).toBeNull();
});

it('discovers only explicit file and folder grant roots for an invited recipient', async () => {
  const { sessions, grants, reads, alice, bob, eve } = await setup();
  const admin = (await sessions.issue('owner')).token;
  const { listShared } = createSharedReadAccess(env.DB);
  const empty = { entries: [], nextCursor: null };
  expect(await grants.create(alice, 'root', 'bob')).toBe(true);
  expect(await grants.create(alice, 'file', 'bob')).toBe(true);
  expect(await grants.create(alice, 'root', 'owner')).toBe(false);
  expect(await listShared(bob)).toEqual({ entries: [
    { id: 'file', name: 'file', kind: 'file' }, { id: 'root', name: 'root', kind: 'folder' },
  ], nextCursor: null });
  for (const token of [alice, eve, admin, 'invalid']) expect(await listShared(token)).toEqual(empty);

  expect(await grants.revoke(alice, 'file', 'bob')).toBe(true);
  expect(await listShared(bob)).toEqual({ entries: [{ id: 'root', name: 'root', kind: 'folder' }], nextCursor: null });
  expect(await reads.get(bob, 'file')).not.toBeNull(); // Still inherited, not discoverable as a root.
  expect(await grants.revoke(alice, 'root', 'bob')).toBe(true);
  expect(await listShared(bob)).toEqual(empty);
});

it('rechecks session and both memberships before discovering grant roots', async () => {
  const { sessions, grants, alice, bob } = await setup();
  const { listShared } = createSharedReadAccess(env.DB);
  const empty = { entries: [], nextCursor: null };
  expect(await grants.create(alice, 'root', 'bob')).toBe(true);
  expect((await listShared(bob)).entries).toHaveLength(1);
  await sessions.revoke(bob);
  expect(await listShared(bob)).toEqual(empty);
  const expired = (await sessions.issue('bob')).token;
  await env.DB.prepare("UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = 'bob'").run();
  expect(await listShared(expired)).toEqual(empty);
  const current = (await sessions.issue('bob')).token;
  expect((await listShared(current)).entries).toHaveLength(1);
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  expect(await listShared(current)).toEqual(empty);
  await env.DB.prepare("UPDATE drive_principals SET status = 'active' WHERE id = 'alice'").run();
  const restoredAlice = (await sessions.issue('alice')).token;
  expect(await grants.create(restoredAlice, 'root', 'bob')).toBe(true);
  expect((await listShared(current)).entries).toHaveLength(1);
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'bob'").run();
  expect(await listShared(current)).toEqual(empty);
});

it.each([
  ['revoked sharer', 'alice', 'bob'], ['revoked recipient', 'bob', 'bob'], ['admin recipient', null, 'owner'],
])('denies a persisted grant with a %s', async (_label, revokedId, recipientId) => {
  const { sessions } = await setup();
  const { token, expiresAt } = await sessions.issue(recipientId);
  if (revokedId) await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = ?").bind(revokedId).run();
  // Model inconsistent rows independently of the grant and session lifecycle triggers.
  await env.DB.prepare("INSERT INTO drive_read_grants VALUES ('root', ?)").bind(recipientId).run();
  if (revokedId === recipientId) {
    await env.DB.prepare('INSERT INTO drive_sessions (token_hash, principal_id, expires_at) VALUES (?, ?, ?)')
      .bind(await tokenHash(token), recipientId, expiresAt).run();
  }
  expect(await createSharedReadAccess(env.DB).listShared(token)).toEqual({ entries: [], nextCursor: null });
});

it('seeks a bounded shared page with the recipient index after the boundary grant is removed', async () => {
  const { grants, alice, bob } = await setup();
  const ids = Array.from({ length: 102 }, (_, i) => `shared-${String(i).padStart(3, '0')}`);
  ids[99] += '\0suffix';
  await env.DB.batch(ids.map((id, index) => listingEntry(id, `name-${102 - index}`)));
  await env.DB.batch(ids.map(id => env.DB.prepare("INSERT INTO drive_read_grants VALUES (?, 'bob')").bind(id)));
  let explain;
  const primary = env.DB.withSession('first-primary');
  const { listShared } = createSharedReadAccess({ withSession(constraint) {
    expect(constraint).toBe('first-primary');
    return { prepare(sql) { return { bind(...values) {
      explain = primary.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values);
      return primary.prepare(sql).bind(...values);
    } }; } };
  } });
  const first = await listShared(bob);
  expect(first.entries.map(entry => entry.id)).toEqual(ids.slice(0, 100));
  expect(first.nextCursor).toBe(ids[99]);
  expect((await listShared(bob, first.nextCursor)).entries.map(entry => entry.id)).toEqual(ids.slice(100));
  expect(await grants.revoke(alice, ids[99], 'bob')).toBe(true);
  const second = await listShared(bob, first.nextCursor);
  expect(second.entries.map(entry => entry.id)).toEqual(ids.slice(100));
  expect(second.nextCursor).toBeNull();
  const { results } = await explain.all();
  expect(results.map(row => row.detail).join('\n')).toMatch(/drive_read_grants_recipient.*recipient_id=\?.*entry_id>\?/);
});

function listingEntry(id, name, { folderId = 'root', kind = 'folder' } = {}) {
  return env.DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
    VALUES (?, 'alice', ?, ?, ?, ?, ?)`)
    .bind(id, folderId, name, kind, kind === 'file' ? `${id}-key` : null, kind === 'file' ? 0 : null);
}

function seedListing(count, kind = 'folder', { folderId = 'root', prefix = 'item-', idSuffix = '' } = {}) {
  return env.DB.batch(Array.from({ length: count }, (_, i) =>
    listingEntry(`${prefix}${i}${idSuffix}`, `${prefix}${String(i).padStart(3, '0')}`, { folderId, kind })));
}

async function explainPage(token, cursor, direction) {
  let explain;
  const recordingDb = { prepare(sql) { return { bind(...values) {
    explain = env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values);
    return env.DB.prepare(sql).bind(...values);
  } }; } };
  const page = await new ReadAccess(recordingDb).listPage(token, 'root', cursor, direction);
  const { results } = await explain.all();
  return { page, details: results.map(row => row.detail).join('\n') };
}

it.each(['asc', 'desc'])('lists folders first, with a binary name seek in %s order', async (direction) => {
  const { reads, alice } = await setup();
  await seedListing(205, 'file');
  await env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES ('z', 'alice', 'root', 'Z', 'folder')").run();
  const first = await reads.listPage(alice, 'root', null, direction);
  expect(first).toMatchObject({ total: 207, direction, order: 'binary-name' });
  expect(first.entries).toHaveLength(200);
  expect(first.nextCursor).not.toBeNull();
  expect(first.entries.slice(0, 2).map(entry => entry.name)).toEqual(direction === 'asc' ? ['Z', 'nested'] : ['nested', 'Z']);
  const { page: second, details } = await explainPage(alice, first.nextCursor, direction);
  const names = Array.from({ length: 205 }, (_, i) => `item-${String(i).padStart(3, '0')}`);
  if (direction === 'desc') names.reverse();
  expect(second.entries).toHaveLength(7);
  expect([...first.entries.slice(2), ...second.entries].map(entry => entry.name)).toEqual(names);
  expect(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size).toBe(207);
  expect(second).toMatchObject({ total: 207, nextCursor: null });
  expect(details).toMatch(new RegExp(`drive_entries_listing_${direction}.*name[<>]\\?`));
});

it.each(['asc', 'desc'])('keeps the saved boundary and current total after writes in %s order', async (direction) => {
  const { reads, alice } = await setup();
  await seedListing(201);
  await env.DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
    VALUES ('receipt', 'alice', 'root', 'receipt', 'file', 'receipt-key', 0)`).run();
  const first = await reads.listPage(alice, 'root', null, direction);
  expect(first.total).toBe(203);
  expect(first.entries).toHaveLength(200);
  expect(first.entries.every(entry => entry.kind === 'folder')).toBe(true);
  await env.DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(first.entries.at(-1).id).run();
  const remaining = direction === 'asc' ? ['item-200', 'nested', 'receipt'] : ['item-001', 'item-000', 'receipt'];
  const afterDelete = await reads.listPage(alice, 'root', first.nextCursor, direction);
  expect(afterDelete.total).toBe(202);
  expect(afterDelete.entries.map(entry => entry.name)).toEqual(remaining);
  await env.DB.prepare("UPDATE drive_entries SET parent_id = 'elsewhere' WHERE name = ? AND parent_id = 'root'")
    .bind(remaining[0]).run();
  const afterMove = await reads.listPage(alice, 'root', first.nextCursor, direction);
  expect(afterMove).toMatchObject({ total: 201, nextCursor: null });
  expect(afterMove.entries.map(entry => entry.name)).toEqual(remaining.slice(1));
  expect((await reads.listPage(alice, 'elsewhere')).total).toBe(1);
});

it('checks current access before reporting invalid page input', async () => {
  const { sessions, grants, reads, alice, bob, eve } = await setup();
  await seedListing(202);
  await grants.create(alice, 'root', 'bob');
  const first = await reads.listPage(bob, 'root');
  expect(first).toMatchObject({ total: 203, direction: 'asc', order: 'binary-name' });
  expect(first.entries).toHaveLength(200);
  expect(first.nextCursor).not.toBeNull();
  const cursor = first.nextCursor;
  const second = await reads.listPage(bob, 'root', cursor);
  expect(second).toMatchObject({ total: 203, nextCursor: null });
  expect(second.entries).toHaveLength(3);
  expect(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size).toBe(203);
  expect(await reads.listPage(bob, 'elsewhere')).toBeNull();
  expect(await reads.listPage(eve, 'root', first.nextCursor)).toBeNull();
  expect(await reads.listPage(alice, 'elsewhere')).toEqual({ entries: [], total: 0, direction: 'asc', order: 'binary-name', nextCursor: null });
  const envelope = JSON.parse(atob(cursor.replaceAll('-', '+').replaceAll('_', '/')));
  const encode = value => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const invalid = [
    '', 'invalid!', `${cursor}=`, 'x'.repeat(2049),
    ...[{ v: 1 }, { o: 'locale' }, { k: 'other' }, { extra: true },
      { n: '_w' }, { n: 'YQ==' }, { n: '' }, { n: 'Lw' }].map(change => encode({ ...envelope, ...change })),
  ];
  for (const token of invalid) await expect(reads.listPage(bob, 'root', token)).rejects.toThrow(TypeError);
  await expect(reads.listPage(bob, 'nested', cursor)).rejects.toThrow(TypeError);
  await expect(reads.listPage(bob, 'root', first.nextCursor, 'desc')).rejects.toThrow(TypeError);
  await expect(reads.listPage(alice, 'elsewhere', first.nextCursor)).rejects.toThrow(TypeError);
  await expect(reads.listPage(bob, 'root', null, 'invalid')).rejects.toThrow(TypeError);
  await grants.revoke(alice, 'root', 'bob');
  expect(await reads.listPage(bob, 'root', first.nextCursor)).toBeNull();
  for (const token of invalid) expect(await reads.listPage(bob, 'root', token)).toBeNull();
  expect(await reads.listPage(bob, 'root', null, 'invalid')).toBeNull();
  expect(await grants.create(alice, 'root', 'bob')).toBe(true);
  await sessions.revoke(bob);
  expect(await reads.listPage(bob, 'root', first.nextCursor)).toBeNull();
  expect(await reads.listPage(bob, 'root', invalid[0])).toBeNull();
  const expired = (await sessions.issue('bob')).token;
  await expect(reads.listPage(expired, 'root', invalid[0])).rejects.toThrow(TypeError);
  await env.DB.prepare("UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = 'bob'").run();
  expect(await reads.listPage(expired, 'root', invalid[0])).toBeNull();
});

it.each([0, 199, 200, 201])('reports the exact total and page boundary for %i children', async (count) => {
  const { reads, alice } = await setup();
  if (count) await seedListing(count, 'folder', { folderId: 'elsewhere' });
  const first = await reads.listPage(alice, 'elsewhere');
  expect(first.total).toBe(count);
  expect(first.entries).toHaveLength(Math.min(count, 200));
  expect(first.nextCursor === null).toBe(count <= 200);
  if (count > 200) {
    const second = await reads.listPage(alice, 'elsewhere', first.nextCursor);
    expect(second).toMatchObject({ total: count, nextCursor: null });
    expect(second.entries.map(entry => entry.id)).toEqual(['item-200']);
  }
});

it('continues a bounded cursor for multi-kilobyte folder and child IDs', async () => {
  const { reads, alice } = await setup();
  const folderId = 'parent-'.repeat(400);
  const idSuffix = 'x'.repeat(3000);
  await listingEntry(folderId, 'long-id-parent').run();
  await seedListing(201, 'folder', { folderId, idSuffix });
  const first = await reads.listPage(alice, folderId);
  expect(first.entries.at(-1).id).toBe(`item-199${idSuffix}`);
  expect(first.nextCursor.length).toBeLessThanOrEqual(2048);
  const second = await reads.listPage(alice, folderId, first.nextCursor);
  expect(second).toMatchObject({ total: 201, nextCursor: null });
  expect(second.entries.map(entry => entry.id)).toEqual([`item-200${idSuffix}`]);
});

it.each([
  ['255-byte multibyte', 'é'.repeat(127) + 'x'],
  ['255-byte escape-heavy', '\\"'.repeat(127) + 'x'],
  ['standalone BOM', String.fromCodePoint(0xfeff)], ['leading BOM', `${String.fromCodePoint(0xfeff)}name`],
])('round-trips a %s boundary and rejects a duplicate sibling', async (_label, name) => {
  const { reads, alice } = await setup();
  await seedListing(199, 'folder', { folderId: 'elsewhere', prefix: '!' });
  await env.DB.batch([
    listingEntry('max-name', name, { folderId: 'elsewhere' }),
    listingEntry('last-file', 'last', { folderId: 'elsewhere', kind: 'file' }),
  ]);
  const first = await reads.listPage(alice, 'elsewhere');
  expect(first.entries.at(-1).name).toBe(name);
  expect(first.nextCursor.length).toBeLessThanOrEqual(595);
  expect((await reads.listPage(alice, 'elsewhere', first.nextCursor)).entries.map(entry => entry.id)).toEqual(['last-file']);
  await expect(listingEntry('duplicate', name, { folderId: 'elsewhere' }).run()).rejects.toThrow(/conflicting metadata/);
});

it.each(['asc', 'desc'])('seeks from an all-folder page into the first file in %s order', async (direction) => {
  const { reads, alice } = await setup();
  await seedListing(199);
  await listingEntry('root-file', 'a-file', { kind: 'file' }).run();
  const first = await reads.listPage(alice, 'root', null, direction);
  expect(first.total).toBe(201);
  expect(first.entries).toHaveLength(200);
  expect(first.entries.every(entry => entry.kind === 'folder')).toBe(true);
  expect(first.nextCursor).not.toBeNull();
  const { page: second, details } = await explainPage(alice, first.nextCursor, direction);
  expect(second).toMatchObject({ total: 201, nextCursor: null });
  expect(second.entries).toEqual([{ id: 'root-file', name: 'a-file', kind: 'file' }]);
  expect(details).toMatch(new RegExp(`drive_entries_listing_${direction}.*name[<>]\\?`));
});

it.each(['asc', 'desc'])('uses the saved cursor after renaming the boundary in %s order', async (direction) => {
  const { reads, alice } = await setup();
  await seedListing(201, 'folder', { prefix: 'rename-' });
  const first = await reads.listPage(alice, 'root', null, direction);
  const boundaryId = first.entries.at(-1).id;
  await env.DB.prepare('UPDATE drive_entries SET name = ? WHERE id = ?')
    .bind(direction === 'asc' ? '!renamed' : 'z-renamed', boundaryId).run();
  const second = await reads.listPage(alice, 'root', first.nextCursor, direction);
  expect(second).toMatchObject({ total: 202, nextCursor: null });
  expect(second.entries.map(entry => entry.name)).toEqual(direction === 'asc'
    ? ['rename-199', 'rename-200'] : ['rename-000', 'nested']);
  expect(second.entries.some(entry => entry.id === boundaryId)).toBe(false);
});

it.each(['asc', 'desc'])('counts insertions on both sides of the boundary in %s order', async (direction) => {
  const { reads, alice } = await setup();
  await seedListing(201);
  const first = await reads.listPage(alice, 'root', null, direction);
  await env.DB.batch(['!new', 'z-new'].map(name => listingEntry(name, name)));
  const second = await reads.listPage(alice, 'root', first.nextCursor, direction);
  expect(second).toMatchObject({ total: 204, nextCursor: null });
  expect(second.entries.map(entry => entry.name)).toEqual(direction === 'asc'
    ? ['item-200', 'nested', 'z-new'] : ['item-001', 'item-000', '!new']);
});

it('keeps binary rather than numeric name order within each kind', async () => {
  const { reads, alice } = await setup();
  await env.DB.batch([
    listingEntry('zdir', 'z'),
    ...['file 10', 'file 2', 'A'].map(name => listingEntry(name, name, { kind: 'file' })),
  ]);
  expect((await reads.listPage(alice, 'root')).entries.map(entry => entry.name)).toEqual(['nested', 'z', 'A', 'file 10', 'file 2']);
  expect((await reads.listPage(alice, 'root', null, 'desc')).entries.map(entry => entry.name)).toEqual(['z', 'nested', 'file 2', 'file 10', 'A']);
});
