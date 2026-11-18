import { decodeCursor, encodeCursor, folderScope, type ListingDirection } from './listing-cursor';

interface Statement {
  bind(...values: (string | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

export interface ReadEntry { id: string; name: string; kind: 'file' | 'folder' }
export interface ReadCursor { name: string; id: string }
export interface ReadPage { entries: ReadEntry[]; nextCursor: ReadCursor | null }
export interface FolderPage {
  entries: ReadEntry[];
  total: number;
  order: 'binary-name';
  direction: ListingDirection;
  nextCursor: string | null;
}
type FolderPageRow = (ReadEntry & { total: null }) | { id: null; name: null; kind: null; total: number };
const pageSize = 200;

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

  async listPage(token: string, folderId: string, cursor: string | null = null, direction: ListingDirection = 'asc'): Promise<FolderPage | null> {
    const hash = await sessionHash(token);
    if (!hash) return null;
    const validDirection = direction === 'asc' || direction === 'desc';
    const scope = cursor !== null && validDirection ? await folderScope(folderId) : null;
    const boundary = cursor !== null && scope !== null ? decodeCursor(cursor, scope, direction) : null;
    const invalid = !validDirection || (cursor !== null && boundary === null);
    const [index, order, comparator] = direction === 'desc'
      ? ['drive_entries_listing_desc', 'DESC', '<'] : ['drive_entries_listing_asc', 'ASC', '>'];
    const ordered = `ORDER BY kind DESC, name COLLATE BINARY ${order}, id ASC`;
    const limit = `${ordered} LIMIT ${pageSize + 1}`;
    const children = `SELECT id, name, kind FROM drive_entries INDEXED BY ${index}
      WHERE owner_id = (SELECT owner_id FROM folder) AND parent_id = ?`;
    // Separate ranges let the index seek within a kind. Binary sibling names
    // are unique, so the cursor needs neither a row lookup nor an ID tie-break.
    const ranges = boundary ? `same_kind AS (
      ${children} AND kind = ? AND name COLLATE BINARY ${comparator} ? ${limit}
    ), later_kind AS (
      ${children} AND kind < ? ${limit}
    ), children AS (
      SELECT * FROM (SELECT * FROM same_kind UNION ALL SELECT * FROM later_kind) ${limit}
    )` : `children AS (${children} ${invalid ? 'AND 0' : ''} ${limit})`;
    // The sentinel distinguishes an authorized empty folder from unavailable
    // input and carries its live count in the same snapshot as the page rows.
    const { results: rows } = await this.db.prepare(`${access}, folder AS (
      SELECT e.id, e.owner_id FROM drive_entries e JOIN permitted p ON p.id = e.id WHERE e.kind = 'folder'
    ), ${ranges} SELECT id, name, kind, NULL AS total FROM children UNION ALL
      SELECT NULL, NULL, NULL, counts.item_count FROM folder
        JOIN drive_folder_counts counts ON counts.folder_id = folder.id
      ${ordered}`)
      .bind(folderId, hash, folderId, folderId, ...(boundary ? [boundary.kind, boundary.name, folderId, boundary.kind] : []))
      .all<FolderPageRow>();
    const sentinel = rows.find(row => row.id === null);
    if (!sentinel) return null;
    if (invalid) throw new TypeError('Invalid cursor or direction');
    const items = rows.filter(row => row.id !== null);
    const entries = items.slice(0, pageSize).map(({ id, name, kind }) => ({ id, name, kind }));
    const nextCursor = items.length > pageSize
      ? encodeCursor(entries[pageSize - 1], scope ?? await folderScope(folderId), direction) : null;
    return { entries, total: sentinel.total, order: 'binary-name', direction, nextCursor };
  }
}
