import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';

it('moves and renames metadata privately and atomically on D1', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec("INSERT INTO drive_principals (id, role, status) VALUES ('alice', 'member', 'active'), ('bob', 'owner', 'active'), ('revoked', 'member', 'revoked')");
  const insert = (id, owner, parent, name, kind = 'folder') => env.DB.prepare(`INSERT INTO drive_entries
    (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, owner, parent, name, kind, kind === 'file' ? `object-${id}` : null, kind === 'file' ? 42 : null);
  await env.DB.batch([
    insert('a', 'alice', null, 'a'), insert('child', 'alice', 'a', 'child'),
    insert('b', 'alice', null, 'b'), insert('nested', 'alice', 'b', 'nested'),
    insert('file', 'alice', null, 'file', 'file'), insert('foreign', 'bob', null, 'foreign'),
  ]);
  const metadata = new PrivateMetadata(env.DB);
  const rows = async () => (await env.DB.prepare('SELECT * FROM drive_entries ORDER BY id').all()).results;
  const originalFile = (await rows()).find(({ id }) => id === 'file');
  expect(await metadata.move('alice', 'file', 'a', 'renamed')).toMatchObject({ id: 'file', owner_id: 'alice', parent_id: 'a', name: 'renamed', kind: 'file' });
  expect(await metadata.move('alice', 'file', 'b', 'renamed')).toMatchObject({ parent_id: 'b' });
  expect(await metadata.move('alice', 'file', null, 'root')).toMatchObject({ parent_id: null, name: 'root' });
  expect((await rows()).find(({ id }) => id === 'file')).toEqual({ ...originalFile, name: 'root' });
  expect((await metadata.list('alice', null)).entries.map(({ id }) => id)).toContain('file');

  for (const [id, parent, name] of [
    ['file', 'missing', 'x'], ['file', 'foreign', 'x'], ['a', 'file', 'x'],
    ['file', null, 'b'], ['file', 'b', 'nested'], ['a', 'a', 'x'], ['a', 'child', 'x'],
    ['file', null, 'bad/name'], ['file', null, 'x'.repeat(256)],
  ]) {
    const before = await rows();
    await expect(metadata.move('alice', id, parent, name)).rejects.toThrow();
    expect(await rows()).toEqual(before);
  }
  const beforeDenials = await rows();
  expect(await metadata.move('bob', 'file', null, 'x')).toBeNull();
  expect(await metadata.move('bob', 'missing', null, 'x')).toBeNull();
  expect(await metadata.move('absent', 'file', null, 'x')).toBeNull();
  expect(await metadata.move('revoked', 'file', null, 'x')).toBeNull();
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  expect(await metadata.move('alice', 'file', null, 'x')).toBeNull();
  expect(await rows()).toEqual(beforeDenials);
  await env.DB.exec('DROP VIEW drive_active_members');
  await expect(metadata.move('alice', 'file', null, 'x')).rejects.toThrow();
  expect(await rows()).toEqual(beforeDenials);
});
