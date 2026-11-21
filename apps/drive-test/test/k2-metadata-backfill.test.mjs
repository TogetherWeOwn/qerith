import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { backfillK2MetadataPage } from '../../drive/src/lib/server/metadata/k2-metadata-backfill.ts';
import schema from '../../drive/src/lib/server/metadata/k2-metadata-schema.sql?raw';
import { UploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { parts, seed, sql } from './fixtures/upload-completion.mjs';
import { etag, seedBoundPublication } from './fixtures/upload-publication-generation.mjs';

it('seeks bounded batches, preserves recorded metadata and uses only pinned size evidence', async () => {
  const { id: pinned } = await seedBoundPublication('k2-pinned');
  const { id: resized } = await seedBoundPublication('k2-resized');
  const { token, intent, identity } = await seed('k2-unpinned', { declaredSize: 7 });
  const publication = new UploadPublication(env.DB, async () => ({ etag, size: 7 }), token);
  const { id: unpinned } = await publication.completeAndPublish(identity.ownerId, intent, 2, null, 'legacy', parts);
  expect(await sql('SELECT completion_operation_id, evidence_revision FROM drive_upload_publications WHERE entry_id = ?', unpinned).first())
    .toEqual({ completion_operation_id: null, evidence_revision: null });
  await sql('UPDATE drive_entries SET size_bytes = 8 WHERE id = ?', resized).run();
  await sql(`INSERT INTO drive_entries (id, owner_id, name, kind, object_key, size_bytes) VALUES
    ('x-folder', 'legacy', 'folder.jpg', 'folder', NULL, NULL),
    ('x-legacy', 'legacy', 'file.pdf', 'file', 'legacy-object', 0),
    ('x-recorded', 'legacy', 'recorded', 'folder', NULL, NULL)`).run();
  await env.DB.prepare(schema).run();
  await sql(`INSERT INTO drive_k2_metadata (entry_id, display_type, type_source, modified_at_ms, modified_source)
    VALUES ('x-recorded', 'Project', 'drive-write', 0, 'drive-write')`).run();
  const entries = 'SELECT id, name, size_bytes FROM drive_entries ORDER BY id';
  const { results: before } = await sql(entries).all();
  const { results: plan } = await sql(`EXPLAIN QUERY PLAN SELECT id FROM drive_entries
    WHERE id > ? COLLATE BINARY ORDER BY id COLLATE BINARY LIMIT ?`, '', 2).all();
  expect(plan.map(({ detail }) => detail).join('\n')).toMatch(/SEARCH drive_entries USING PRIMARY KEY \(id>\?\)/);

  const backfill = (afterId, limit = 2) => backfillK2MetadataPage(env.DB, afterId, limit);
  const metadata = () => sql('SELECT * FROM drive_k2_metadata ORDER BY entry_id').all().then(({ results }) => results);
  const first = { scanned: 2, nextAfterId: before[1].id };
  expect(await backfill(null)).toEqual(first);
  const firstRows = await metadata();
  expect(firstRows.map(({ entry_id }) => entry_id)).toEqual([...before.slice(0, 2).map(({ id }) => id), 'x-recorded']);
  expect(await backfill(null)).toEqual(first);
  expect(await metadata()).toEqual(firstRows);
  expect(await backfill(first.nextAfterId)).toEqual({ scanned: 2, nextAfterId: 'x-folder' });
  expect(await backfill('x-folder', 1)).toEqual({ scanned: 1, nextAfterId: 'x-legacy' });
  expect(await backfill('x-legacy', 1)).toEqual({ scanned: 1, nextAfterId: 'x-recorded' });
  expect(await backfill('x-recorded')).toEqual({ scanned: 0, nextAfterId: null });
  expect(await backfill('x-legacy')).toEqual({ scanned: 1, nextAfterId: null });
  for (const invalid of [-1, 0, 1.5, 201, NaN]) await expect(backfill(null, invalid)).rejects.toThrow(RangeError);

  const rows = Object.fromEntries((await metadata()).map(({ entry_id, ...fields }) => [entry_id, fields]));
  const legacy = (display_type, verified_size_bytes = null) => ({
    display_type, type_source: 'entry-kind', modified_at_ms: null, modified_source: null, verified_size_bytes,
  });
  expect(rows).toEqual({
    [pinned]: legacy('File', 7), [resized]: legacy('File'), [unpinned]: legacy('File'),
    'x-folder': legacy('Folder'), 'x-legacy': legacy('File'),
    'x-recorded': { ...legacy('Project'), type_source: 'drive-write', modified_at_ms: 0, modified_source: 'drive-write' },
  });
  await expect(sql("UPDATE drive_k2_metadata SET modified_at_ms = 123 WHERE entry_id = 'x-legacy'").run()).rejects.toThrow(/CHECK constraint/);
  expect((await sql(entries).all()).results).toEqual(before);

  await sql(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 201)
    INSERT INTO drive_entries (id, owner_id, name, kind)
    SELECT printf('y-%03d', n), 'legacy', printf('batch %03d', n), 'folder' FROM ids`).run();
  expect(await backfillK2MetadataPage(env.DB, 'x-recorded')).toEqual({ scanned: 200, nextAfterId: 'y-200' });
  expect(await backfillK2MetadataPage(env.DB, 'y-200')).toEqual({ scanned: 1, nextAfterId: null });
});
