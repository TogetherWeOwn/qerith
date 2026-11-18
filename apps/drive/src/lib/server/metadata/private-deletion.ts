import { tokenHash } from '../identity/sessions';

interface Statement { bind(...values: string[]): Statement }
interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}

/** Server-only. The route must enforce confirmation and CSRF before calling. */
export class PrivateDeletion {
  constructor(private readonly db: Database) {}

  async delete(sessionToken: string, entryId: string): Promise<boolean> {
    if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return false;
    const hash = await tokenHash(sessionToken);
    const deletionId = crypto.randomUUID();
    // One D1 transaction journals and removes the same authorized tree.
    const [captured] = await this.db.batch([
      this.db.prepare(`INSERT INTO drive_deleted_entries (entry_id, deletion_id, owner_id, object_key)
        WITH RECURSIVE subtree(id, owner_id, object_key) AS (
          SELECT e.id, e.owner_id, e.object_key FROM drive_entries e JOIN drive_sessions s ON s.principal_id = e.owner_id
          JOIN drive_active_members m ON m.id = e.owner_id
          WHERE e.id = ? AND s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          UNION ALL
          SELECT e.id, e.owner_id, e.object_key FROM subtree t JOIN drive_entries e
            ON e.owner_id = t.owner_id AND e.parent_id = t.id
        ) SELECT id, ?, owner_id, object_key FROM subtree`).bind(entryId, hash, deletionId),
      this.db.prepare(`DELETE FROM drive_entries WHERE id IN (
        SELECT entry_id FROM drive_deleted_entries WHERE deletion_id = ?)`).bind(deletionId),
    ]);
    return captured.meta.changes > 0;
  }
}
