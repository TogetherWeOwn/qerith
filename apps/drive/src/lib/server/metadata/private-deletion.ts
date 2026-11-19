import { tokenHash } from '../identity/sessions';
import type { S3Config } from '../s3/config';
import { uploadStorageEvidence } from './upload-storage-evidence';

interface Statement { bind(...values: string[]): Statement }
interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}

export const MAX_DELETION_ENTRIES = 128; // Includes the selected entry.
export const MAX_DELETION_DEPTH = 32; // Edges below the selected entry.

const generationGuard = `AND NOT EXISTS (
  SELECT 1 FROM subtree f WHERE f.kind = 'file' AND NOT EXISTS (
    SELECT 1 FROM drive_published_generations g
    JOIN drive_upload_publications p ON p.entry_id = g.entry_id
    WHERE g.entry_id = f.id AND g.owner_id = f.owner_id AND g.object_key = f.object_key
      AND g.size_bytes = f.size_bytes AND p.object_etag = g.etag AND p.size_bytes = g.size_bytes
      AND g.endpoint = ? AND g.bucket = ? AND g.storage_epoch = ?
      AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_quarantine q WHERE q.operation_id = p.completion_operation_id)
      AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones t WHERE t.intent_id = g.intent_id)
  )
)`;

// SQLite may queue a parent's children before applying the recursive result
// limit. Cap the indexed child lookup too and keep one overflow row.
const boundedChildren = `CROSS JOIN drive_entries e
  WHERE t.depth <= ${MAX_DELETION_DEPTH} AND e.id IN (
    SELECT c.id FROM drive_entries c INDEXED BY drive_entries_owner_parent
    WHERE c.owner_id = t.owner_id AND c.parent_id = t.id LIMIT ${MAX_DELETION_ENTRIES + 1}
  ) LIMIT ${MAX_DELETION_ENTRIES + 1}`;
const boundedTree = `WHERE (SELECT COUNT(*) FROM subtree) <= ${MAX_DELETION_ENTRIES}
  AND NOT EXISTS (SELECT 1 FROM subtree WHERE depth > ${MAX_DELETION_DEPTH})`;

type StorageScope = readonly [endpoint: string, bucket: string, epoch: string];

async function journalDeletion(db: Database, sessionToken: string, entryId: string, storage?: StorageScope) {
  if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
  const hash = await tokenHash(sessionToken);
  const deletionId = crypto.randomUUID();
  const [captured] = await db.batch([
    db.prepare(`INSERT INTO drive_deleted_entries (entry_id, deletion_id, owner_id, object_key)
      WITH RECURSIVE subtree(id, owner_id, kind, object_key, size_bytes, depth) AS (
        SELECT e.id, e.owner_id, e.kind, e.object_key, e.size_bytes, 0
        FROM drive_entries e JOIN drive_sessions s ON s.principal_id = e.owner_id
        JOIN drive_active_members m ON m.id = e.owner_id
        WHERE e.id = ? AND s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        UNION ALL
        SELECT e.id, e.owner_id, e.kind, e.object_key, e.size_bytes, t.depth + 1
        FROM subtree t ${storage ? boundedChildren : 'JOIN drive_entries e ON e.owner_id = t.owner_id AND e.parent_id = t.id'}
      ) SELECT id, ?, owner_id, object_key FROM subtree
      ${storage ? `${boundedTree} ${generationGuard}` : ''}`).bind(entryId, hash, deletionId, ...(storage ?? [])),
    db.prepare(`DELETE FROM drive_entries WHERE id IN (
      SELECT entry_id FROM drive_deleted_entries WHERE deletion_id = ?)`).bind(deletionId),
  ]);
  return captured.meta.changes > 0 ? { deletionId } : null;
}

/** Internal route adapter. The caller must enforce admission, confirmation and CSRF.
 * Null deliberately conflates missing, unauthorized, unpinned and oversized trees.
 * A receipt is for server-side reconciliation only; batch errors propagate.
 */
export function createAuthorizedPrivateDeletion(db: Database, epoch: string, config: S3Config) {
  const { settings: { endpoint, bucket } } = uploadStorageEvidence(config, epoch);
  return { delete: (token: string, entryId: string) => journalDeletion(db, token, entryId, [endpoint, bucket, epoch]) };
}

/** Lower-level metadata fixture adapter; does not prove a storage generation. */
export class PrivateDeletion {
  constructor(private readonly db: Database) {}

  async delete(sessionToken: string, entryId: string): Promise<boolean> {
    return await journalDeletion(this.db, sessionToken, entryId) !== null;
  }
}
