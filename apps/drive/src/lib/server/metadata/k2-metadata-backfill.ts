interface Statement {
  bind(afterId: string, limit: number): Statement;
}
interface Database {
  prepare(query: string): Statement;
  batch<T>(statements: Statement[]): Promise<{ results: T[] }[]>;
}

const maxPage = 200;
const page = `SELECT id, owner_id, kind, object_key, size_bytes FROM drive_entries
  WHERE id > ? COLLATE BINARY ORDER BY id COLLATE BINARY LIMIT ?`;

// Offline only: no request path or authorization contract. Persist the next
// boundary only after the batch succeeds. A full page can require an empty probe.
export async function backfillK2MetadataPage(db: Database, afterId: string | null, limit = maxPage) {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxPage) throw new RangeError('Invalid K2 backfill limit');
  const boundary = afterId ?? ''; // Drive entry IDs are nonempty.
  const [scan] = await db.batch<{ scanned: number; last_id: string | null }>([
    db.prepare(`SELECT count(*) AS scanned, max(id) AS last_id FROM (${page})`).bind(boundary, limit),
    db.prepare(`INSERT INTO drive_k2_metadata (entry_id, display_type, type_source, verified_size_bytes)
      SELECT e.id, CASE e.kind WHEN 'folder' THEN 'Folder' ELSE 'File' END, 'entry-kind',
        CASE WHEN e.kind = 'file' AND EXISTS (
          SELECT 1 FROM drive_upload_publications p WHERE p.entry_id = e.id AND p.owner_id = e.owner_id
            AND p.object_key = e.object_key AND p.size_bytes = e.size_bytes AND p.completion_operation_id IS NOT NULL
        ) THEN e.size_bytes END
      FROM (${page}) e WHERE 1
      ON CONFLICT (entry_id) DO NOTHING`).bind(boundary, limit),
  ]);
  const { scanned, last_id } = scan.results[0];
  return { scanned, nextAfterId: scanned === limit ? last_id : null };
}
