import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { Sessions, tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';
import { moveSessionEntry } from '../../drive/src/lib/server/metadata/move-entry.ts';
import { ReadAccess } from '../../drive/src/lib/server/metadata/read-access.ts';

const sessions = new Sessions(env.DB);
const change = (token, id, input) => moveSessionEntry(env.DB, token, id, input);
const rename = (name) => ({ kind: 'rename', name });
const move = (parentId, name) => ({ kind: 'move', parentId, name });
const all = async (sql) => (await env.DB.prepare(sql).all()).results;
const entries = () => all('SELECT * FROM drive_entries ORDER BY id');
const counts = () => all('SELECT * FROM drive_folder_counts ORDER BY folder_id');
const usage = () => all('SELECT * FROM drive_owner_usage ORDER BY owner_id');
const snapshot = async () => [await entries(), await counts(), await usage()];

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drive_entries'),
    env.DB.prepare('DELETE FROM drive_principals'),
    env.DB.prepare("INSERT INTO drive_principals (id, role, status) VALUES ('alice', 'member', 'active'), ('bob', 'owner', 'active')"),
    env.DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES
      ('a', 'alice', NULL, 'A', 'folder'), ('b', 'alice', NULL, 'B', 'folder'),
      ('child', 'alice', 'a', 'Child', 'folder'), ('deep', 'alice', 'child', 'Deep', 'folder'),
      ('nested', 'alice', 'b', 'Nested', 'folder'), ('foreign', 'bob', NULL, 'Foreign', 'folder'),
      ('foreign-child', 'bob', 'foreign', 'A', 'folder'), ('shared', 'bob', NULL, 'Shared', 'folder')`),
    env.DB.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES
      ('file', 'alice', 'a', 'Report.txt', 'file', 'file-key', 42),
      ('shared-file', 'bob', 'shared', 'Report.txt', 'file', 'shared-key', 7)`),
    env.DB.prepare("INSERT INTO drive_read_grants (entry_id, recipient_id) VALUES ('shared', 'alice'), ('shared-file', 'alice')"),
  ]);
});

function beforeWrite(action) {
  return { withSession(constraint) {
    expect(constraint).toBe('first-primary');
    const primary = env.DB.withSession(constraint);
    return { prepare: primary.prepare.bind(primary), async batch(statements) {
      await action();
      return primary.batch(statements);
    } };
  } };
}

it('renames and moves owned files and folders without changing file identity or descendants', async () => {
  const { token } = await sessions.issue('alice');
  const before = await entries();
  const bytes = await usage();
  expect(await change(token, 'file', rename('Final.txt'))).toEqual({ id: 'file', parentId: 'a', name: 'Final.txt', kind: 'file' });
  expect(await change(token, 'file', move('nested'))).toMatchObject({ parentId: 'nested', name: 'Final.txt' });
  expect(await change(token, 'file', move(null, 'Root.txt'))).toMatchObject({ parentId: null, name: 'Root.txt' });
  expect(await change(token, 'file', rename('Root.txt'))).toMatchObject({ parentId: null, name: 'Root.txt' });
  expect(await change(token, 'child', rename('Renamed'))).toEqual({ id: 'child', parentId: 'a', name: 'Renamed', kind: 'folder' });
  expect(await change(token, 'child', move(null))).toMatchObject({ parentId: null, name: 'Renamed' });
  expect(await change(token, 'child', move('nested'))).toMatchObject({ parentId: 'nested', name: 'Renamed' });
  expect(await entries()).toEqual(before.map(row => row.id === 'file' ? { ...row, name: 'Root.txt', parent_id: null }
    : row.id === 'child' ? { ...row, name: 'Renamed', parent_id: 'nested' } : row));
  expect(await counts()).toEqual((await entries()).filter(row => row.kind === 'folder').map(({ id }) => ({
    folder_id: id, item_count: id === 'a' ? 0 : ['b', 'child', 'foreign', 'nested', 'shared'].includes(id) ? 1 : 0,
  })));
  expect(await usage()).toEqual(bytes);
});

it('resolves rename parent and move name at the write rather than from an earlier read', async () => {
  const { token } = await sessions.issue('alice');
  const moved = beforeWrite(() => change(token, 'file', move('nested')));
  expect(await moveSessionEntry(moved, token, 'file', rename('New.txt'))).toMatchObject({ parentId: 'nested', name: 'New.txt' });
  const renamed = beforeWrite(() => change(token, 'file', rename('Latest.txt')));
  expect(await moveSessionEntry(renamed, token, 'file', move(null))).toMatchObject({ parentId: null, name: 'Latest.txt' });
});

it('returns 409 only for actionable sibling conflicts and leaves denied changes untouched', async () => {
  const { token } = await sessions.issue('alice');
  const before = await snapshot();
  for (const input of [rename('Child'), move(null, 'B'), move('b', 'Nested')]) {
    expect(await change(token, 'file', input)).toBe(409);
  }
  for (const [id, input] of [
    ['a', move('a', 'Child')], ['a', move('child', 'Deep')], ['a', move('deep')],
    ['file', move('missing')], ['child', move('file')], ['missing', move(null, 'B')],
  ]) expect(await change(token, id, input)).toBe(404);
  for (const name of ['', ' . ', 'a/b', 'a\0b', '\ud800', 'é'.repeat(128)]) {
    await expect(change(token, 'file', rename(name))).rejects.toThrow(TypeError);
  }
  expect(await snapshot()).toEqual(before);
});

it('does not treat a read grant or the Drive owner role as ownership of an entry', async () => {
  const { token: alice } = await sessions.issue('alice');
  const { token: bob } = await sessions.issue('bob');
  const reader = new ReadAccess(env.DB.withSession('first-primary'));
  expect(await reader.get(alice, 'shared')).toMatchObject({ kind: 'folder' });
  expect(await reader.get(alice, 'shared-file')).toMatchObject({ kind: 'file' });
  const before = await snapshot();
  for (const [token, id, input] of [
    [alice, 'foreign', rename('B')], [alice, 'shared', rename('B')], [alice, 'shared-file', move('a')],
    [alice, 'a', move('foreign')], [alice, 'file', move('shared')], [bob, 'file', rename('Shared')],
    [bob, 'shared-file', move('a')],
  ]) expect(await change(token, id, input)).toBe(404);
  expect(await snapshot()).toEqual(before);
});

it.each(['revoked session', 'expired session', 'inactive principal'])('denies a %s at the write boundary', async (reason) => {
  const { token, expiresAt } = await sessions.issue('alice');
  expect(await sessions.lookup(token)).toMatchObject({ id: 'alice' });
  const before = await snapshot();
  const hash = await tokenHash(token);
  const db = beforeWrite(async () => {
    if (reason === 'revoked session') await sessions.revoke(token);
    else if (reason === 'expired session') await env.DB.prepare('UPDATE drive_sessions SET expires_at = 1 WHERE token_hash = ?').bind(hash).run();
    else {
      await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
      await env.DB.prepare("INSERT INTO drive_sessions (token_hash, principal_id, expires_at) VALUES (?, 'alice', ?)").bind(hash, expiresAt).run();
    }
  });
  expect(await moveSessionEntry(db, token, 'file', move('b'))).toBe(401);
  expect(await change(token, 'file', rename('Child'))).toBe(401);
  expect(await snapshot()).toEqual(before);
});

it('rolls back a move when a schema guard aborts after decrementing the source count', async () => {
  const { token } = await sessions.issue('alice');
  await env.DB.prepare("DELETE FROM drive_folder_counts WHERE folder_id = 'nested'").run();
  const before = await snapshot();
  await expect(change(token, 'file', move('nested'))).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});
