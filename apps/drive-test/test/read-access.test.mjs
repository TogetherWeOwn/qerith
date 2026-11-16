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
