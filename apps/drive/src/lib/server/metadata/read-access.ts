interface Statement {
  bind(...values: (string | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

export interface ReadEntry { id: string; name: string; kind: 'file' | 'folder' }
export interface ReadCursor { name: string; id: string }
export interface ReadPage { entries: ReadEntry[]; nextCursor: ReadCursor | null }

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
async function sessionHash(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Anchor at the requested entry, not at a previously authorized ancestor. Each
// statement rechecks both parties and the session against the current tree.
const access = `WITH RECURSIVE ancestors(id, parent_id, owner_id) AS (
  SELECT id, parent_id, owner_id FROM drive_entries WHERE id = ?
  UNION
  SELECT e.id, e.parent_id, e.owner_id FROM drive_entries e
    JOIN ancestors a ON e.id = a.parent_id AND e.owner_id = a.owner_id
), permitted AS (
  SELECT target.id FROM drive_entries target
  JOIN drive_principals owner ON owner.id = target.owner_id AND owner.status = 'active'
  JOIN drive_sessions s ON s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  JOIN drive_principals reader ON reader.id = s.principal_id AND reader.status = 'active'
  WHERE target.id = ? AND (target.owner_id = reader.id OR EXISTS (
    SELECT 1 FROM ancestors a JOIN drive_read_grants g ON g.entry_id = a.id
    WHERE g.recipient_id = reader.id
  ))
)`;

// Server-only: never serialize object keys or the database result into a response.
// Authorization at resolution does not replace checks at streaming/ticket boundaries.
export class ReadAccess {
  constructor(private readonly db: Database) {}

  async get(token: string, id: string): Promise<ReadEntry | null> {
    const hash = await sessionHash(token);
    if (!hash) return null;
    return this.db.prepare(`${access} SELECT e.id, e.name, e.kind FROM drive_entries e
      JOIN permitted p ON p.id = e.id`).bind(id, hash, id).first<ReadEntry>();
  }

  async resolveObject(token: string, id: string): Promise<{ objectKey: string; sizeBytes: number } | null> {
    const hash = await sessionHash(token);
    if (!hash) return null;
    return this.db.prepare(`${access} SELECT e.object_key AS objectKey, e.size_bytes AS sizeBytes
      FROM drive_entries e JOIN permitted p ON p.id = e.id WHERE e.kind = 'file'`)
      .bind(id, hash, id).first<{ objectKey: string; sizeBytes: number }>();
  }

  async list(token: string, folderId: string, cursor: ReadCursor | null = null): Promise<ReadPage | null> {
    if (cursor !== null && (typeof cursor.name !== 'string' || typeof cursor.id !== 'string')) {
      throw new TypeError('Invalid cursor');
    }
    const hash = await sessionHash(token);
    if (!hash) return null;
    // A sentinel distinguishes an accessible empty folder from an inaccessible ID
    // without an authorization query separate from the listing.
    const boundary = cursor ? 'AND (e.name, e.id) > (?, ?)' : '';
    const rows = (await this.db.prepare(`${access}, folder AS (
      SELECT e.id, e.owner_id FROM drive_entries e JOIN permitted p ON p.id = e.id WHERE e.kind = 'folder'
    ), children AS (
      SELECT e.id, e.name, e.kind FROM drive_entries e INDEXED BY drive_entries_sibling_name
        JOIN folder f ON e.owner_id = f.owner_id
      WHERE COALESCE(e.parent_id, '') = ? ${boundary} ORDER BY e.name, e.id LIMIT 101
    ) SELECT id, name, kind FROM children UNION ALL
      SELECT NULL, NULL, NULL FROM folder ORDER BY name, id`)
      .bind(folderId, hash, folderId, folderId, ...(cursor ? [cursor.name, cursor.id] : []))
      .all<ReadEntry | { id: null; name: null; kind: null }>()).results;
    if (!rows.some((row) => row.id === null)) return null;
    const items = rows.filter((row): row is ReadEntry => row.id !== null);
    const entries = items.slice(0, 100);
    const last = entries[entries.length - 1];
    return { entries, nextCursor: items.length > 100 ? { name: last.name, id: last.id } : null };
  }
}
