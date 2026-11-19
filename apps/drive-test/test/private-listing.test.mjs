import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';

it('lists private root and nested pages with indexed keyset boundaries', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  await env.DB.exec("INSERT INTO drive_principals (id, role, status) VALUES ('alice', 'member', 'active'), ('bob', 'owner', 'active'), ('revoked', 'member', 'revoked')");
  const insert = (id, owner, parent, name, kind = 'folder') => env.DB.prepare(`INSERT INTO drive_entries
    (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, owner, parent, name, kind, kind === 'file' ? `object-${id}` : null, kind === 'file' ? 0 : null);
  await env.DB.batch([
    insert('parent', 'alice', null, 'parent'), insert('foreign', 'bob', null, 'foreign'),
    insert('file', 'alice', null, 'file', 'file'),
    ...Array.from({ length: 205 }, (_, n) => insert(`r${n}`, 'alice', null, `root-${String(n).padStart(3, '0')}`)),
    ...Array.from({ length: 102 }, (_, n) => insert(`n${n}`, 'alice', 'parent', `nested-${String(n).padStart(3, '0')}`)),
    insert('other', 'bob', 'foreign', 'secret'),
  ]);
  const metadata = new PrivateMetadata(env.DB);
  const collect = async (parent) => {
    const pages = [];
    let cursor = null;
    do {
      const page = await metadata.list('alice', parent, cursor);
      pages.push(page);
      cursor = page.nextCursor;
    } while (cursor);
    return pages;
  };
  const root = await collect(null);
  expect(root.map((page) => page.entries.length)).toEqual([100, 100, 7]);
  const ids = root.flatMap((page) => page.entries.map((entry) => entry.id));
  expect(new Set(ids).size).toBe(207);
  expect(ids).not.toContain('foreign');
  expect(root[0].nextCursor).toEqual({ name: root[0].entries[99].name, id: root[0].entries[99].id });
  expect(root[2].nextCursor).toBeNull();
  const nested = await collect('parent');
  expect(nested.map((page) => page.entries.length)).toEqual([100, 2]);
  expect(nested.flatMap((page) => page.entries.map((entry) => entry.name)))
    .toEqual(Array.from({ length: 102 }, (_, n) => `nested-${String(n).padStart(3, '0')}`));
  expect((await metadata.list('alice', 'parent', { name: 'nested-099', id: 'n99' })).entries.map((entry) => entry.name))
    .toEqual(['nested-100', 'nested-101']);
  for (const parent of ['missing', 'foreign', 'file', 'n0']) {
    expect(await metadata.list('alice', parent)).toEqual({ entries: [], nextCursor: null });
  }
  for (const principal of ['absent', 'revoked']) {
    expect(await metadata.list(principal, null)).toEqual({ entries: [], nextCursor: null });
  }
  const first = await metadata.list('alice', null);
  await env.DB.prepare("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'").run();
  expect(await metadata.list('alice', null, first.nextCursor)).toEqual({ entries: [], nextCursor: null });
  await env.DB.exec('DROP VIEW drive_active_members');
  await expect(metadata.list('alice', null)).rejects.toThrow();
});

it('uses the existing sibling index for owner, parent and cursor order', async () => {
  await applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS);
  const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT id, name FROM drive_entries
    WHERE owner_id = ? AND COALESCE(parent_id, '') = COALESCE(?, '') AND (name, id) > (?, ?)
    ORDER BY name, id LIMIT 101`).bind('alice', null, 'x', 'x').all();
  const detail = plan.results.map((row) => row.detail).join(' ');
  expect(detail).toContain('drive_entries_sibling_name');
  expect(detail).not.toContain('TEMP B-TREE');
});
