import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { backfillK2MetadataPage } from '../../drive/src/lib/server/metadata/k2-metadata-backfill.ts';
import schema from '../../drive/src/lib/server/metadata/k2-metadata-schema.sql?raw';

it('rolls back a failed page and resumes from the last committed binary checkpoint', async () => {
  const db = env.DB;
  // SQLite BINARY puts U+E000 before U+10000; JS UTF-16 string order does not.
  const bmp = `page-${String.fromCodePoint(0xe000)}`;
  const supplementary = 'page-\u{10000}';
  await applyD1Migrations(db, env.DRIVE_MIGRATIONS);
  await db.prepare(`INSERT INTO drive_entries (id, owner_id, name, kind) VALUES
    (?, 'legacy', 'supplementary', 'folder'), ('page-a', 'legacy', 'regular', 'folder'),
    (?, 'legacy', 'bmp', 'folder'), ('page-0', 'legacy', 'checkpoint', 'folder')`).bind(supplementary, bmp).run();
  await db.prepare(schema).run();
  const ids = async () => (await db.prepare('SELECT entry_id FROM drive_k2_metadata ORDER BY entry_id').all())
    .results.map(({ entry_id }) => entry_id);
  const { nextAfterId } = await backfillK2MetadataPage(db, null, 1);
  expect(nextAfterId).toBe('page-0');

  // D1 rolls back the page's INSERT statement when the trigger fails.
  await db.prepare(`CREATE TRIGGER fail_k2_page AFTER INSERT ON drive_k2_metadata
    WHEN NEW.entry_id > 'page-a'
    BEGIN SELECT RAISE(FAIL, 'K2 fixture failure'); END`).run();
  await expect(backfillK2MetadataPage(db, nextAfterId, 2)).rejects.toThrow(/K2 fixture failure/);
  expect(await ids()).toEqual(['page-0']);
  await db.prepare('DROP TRIGGER fail_k2_page').run();

  expect(await backfillK2MetadataPage(db, nextAfterId, 2)).toEqual({ scanned: 2, nextAfterId: bmp });
  expect(await ids()).toEqual(['page-0', 'page-a', bmp]);
  expect(await backfillK2MetadataPage(db, bmp, 2)).toEqual({ scanned: 1, nextAfterId: null });
  expect(await ids()).toEqual(['page-0', 'page-a', bmp, supplementary]);
});
