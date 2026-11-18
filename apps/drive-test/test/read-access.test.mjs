import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';
import { ReadGrants } from '../../drive/src/lib/server/metadata/read-grants.ts';
import { ReadAccess } from '../../drive/src/lib/server/metadata/read-access.ts';

async function setup() {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drive_read_grants'),
    env.DB.prepare('DELETE FROM drive_entries'),
    env.DB.prepare('DELETE FROM drive_sessions'),
    env.DB.prepare('DELETE FROM drive_credentials'),
    env.DB.prepare('DELETE FROM drive_principals'),
    env.DB.prepare("INSERT INTO drive_principals VALUES ('owner', 'owner', 'active'), ('alice', 'member', 'active'), ('bob', 'member', 'active'), ('eve', 'member', 'active')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('root', 'alice', 'root', 'folder'), ('elsewhere', 'alice', 'elsewhere', 'folder'), ('other', 'eve', 'other', 'folder')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES ('nested', 'alice', 'root', 'nested', 'folder')"),
    env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES ('file', 'alice', 'nested', 'file', 'file', 'secret-key', 7)"),
  ]);
  const sessions = new Sessions(env.DB);
  return { sessions, grants: new ReadGrants(env.DB), reads: new ReadAccess(env.DB),
    alice: (await sessions.issue('alice')).token, bob: (await sessions.issue('bob')).token,
    eve: (await sessions.issue('eve')).token };
}

it('authorizes direct and inherited reads and lists without disclosing parents or owners', async () => {
  const { grants, reads, alice, bob, eve } = await setup();
  expect(await reads.get(alice, 'file')).toEqual({ id: 'file', name: 'file', kind: 'file' });
  expect(await reads.get(bob, 'file')).toBeNull();
  expect(await reads.list(bob, 'nested')).toBeNull();
  expect(await reads.get(bob, 'missing')).toBeNull();
  expect(await reads.resolveObject(eve, 'file')).toBeNull();
  expect(await grants.create(alice, 'root', 'bob')).toBe(true);
  expect(await reads.get(bob, 'file')).toEqual({ id: 'file', name: 'file', kind: 'file' });
  expect(await reads.resolveObject(bob, 'file')).toEqual({ objectKey: 'secret-key', sizeBytes: 7 });
  expect(await reads.list(bob, 'nested')).toEqual({ entries: [{ id: 'file', name: 'file', kind: 'file' }], nextCursor: null });
  expect(await reads.list(bob, 'file')).toBeNull();
  expect(await reads.get(bob, 'other')).toBeNull();
  expect(await grants.create(bob, 'file', 'eve')).toBe(false);
  expect(await grants.revoke(alice, 'root', 'bob')).toBe(true);
  expect(await reads.resolveObject(bob, 'file')).toBeNull();
  expect(await grants.create(alice, 'file', 'bob')).toBe(true);
  expect(await reads.get(bob, 'file')).not.toBeNull();
  expect(await reads.get(bob, 'nested')).toBeNull();
});

it('re-evaluates inheritance on additions, moves, session and membership changes', async () => {
  const { sessions, grants, reads, alice, bob } = await setup();
  await grants.create(alice, 'root', 'bob');
  await env.DB.prepare("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES ('new', 'alice', 'root', 'new', 'folder')").run();
  expect(await reads.list(bob, 'new')).toEqual({ entries: [], nextCursor: null });
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

function seedListing(count, kind = 'folder') {
  return env.DB.batch(Array.from({ length: count }, (_, i) => env.DB.prepare(`
    INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
    VALUES (?, 'alice', 'root', ?, ?, ?, ?)
  `).bind(`item-${i}`, `item-${String(i).padStart(3, '0')}`, kind,
    kind === 'file' ? `item-key-${i}` : null, kind === 'file' ? 0 : null)));
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
  let explain;
  const recordingDb = { prepare(sql) { return { bind(...values) {
    explain = env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values);
    return env.DB.prepare(sql).bind(...values);
  } }; } };
  const second = await new ReadAccess(recordingDb).listPage(alice, 'root', first.nextCursor, direction);
  const names = Array.from({ length: 205 }, (_, i) => `item-${String(i).padStart(3, '0')}`);
  if (direction === 'desc') names.reverse();
  expect([...first.entries.slice(2), ...second.entries].map(entry => entry.name)).toEqual(names);
  expect(second).toMatchObject({ total: 207, nextCursor: null });
  const { results } = await explain.all();
  expect(results.map(row => row.detail).join('\n')).toMatch(new RegExp(`drive_entries_listing_${direction}.*name[<>]\\?`));
});

it.each(['asc', 'desc'])('keeps the saved boundary and current total after writes in %s order', async (direction) => {
  const { reads, alice } = await setup();
  await seedListing(201);
  const first = await reads.listPage(alice, 'root', null, direction);
  expect(first.total).toBe(202);
  expect(first.entries).toHaveLength(200);
  expect(first.nextCursor).not.toBeNull();
  await env.DB.prepare('DELETE FROM drive_entries WHERE id = ?').bind(first.entries.at(-1).id).run();
  const remaining = direction === 'asc' ? ['item-200', 'nested'] : ['item-001', 'item-000'];
  const afterDelete = await reads.listPage(alice, 'root', first.nextCursor, direction);
  expect(afterDelete.total).toBe(201);
  expect(afterDelete.entries.map(entry => entry.name)).toEqual(remaining);
  await env.DB.prepare("UPDATE drive_entries SET parent_id = 'elsewhere' WHERE name = ? AND parent_id = 'root'")
    .bind(direction === 'asc' ? 'item-200' : 'item-001').run();
  const afterMove = await reads.listPage(alice, 'root', first.nextCursor, direction);
  expect(afterMove).toMatchObject({ total: 200, nextCursor: null });
  expect(afterMove.entries.map(entry => entry.name)).toEqual(remaining.slice(1));
  expect((await reads.listPage(alice, 'elsewhere')).total).toBe(1);
});

it('checks current access before reporting invalid page input', async () => {
  const { sessions, grants, reads, alice, bob, eve } = await setup();
  await seedListing(200);
  await grants.create(alice, 'root', 'bob');
  const first = await reads.listPage(bob, 'root');
  expect(first).toMatchObject({ total: 201, direction: 'asc', order: 'binary-name' });
  expect(first.nextCursor).not.toBeNull();
  expect(await reads.listPage(bob, 'elsewhere')).toBeNull();
  expect(await reads.listPage(eve, 'root', first.nextCursor)).toBeNull();
  expect(await reads.listPage(alice, 'elsewhere')).toEqual({ entries: [], total: 0, direction: 'asc', order: 'binary-name', nextCursor: null });
  for (const input of ['invalid!', 'x'.repeat(2049)]) {
    await expect(reads.listPage(bob, 'root', input)).rejects.toThrow(TypeError);
  }
  await expect(reads.listPage(bob, 'root', first.nextCursor, 'desc')).rejects.toThrow(TypeError);
  await expect(reads.listPage(alice, 'elsewhere', first.nextCursor)).rejects.toThrow(TypeError);
  await grants.revoke(alice, 'root', 'bob');
  expect(await reads.listPage(bob, 'root', first.nextCursor)).toBeNull();
  expect(await reads.listPage(bob, 'root', 'invalid!')).toBeNull();
  await grants.create(alice, 'root', 'bob');
  await sessions.revoke(bob);
  expect(await reads.listPage(bob, 'root', first.nextCursor)).toBeNull();
});
