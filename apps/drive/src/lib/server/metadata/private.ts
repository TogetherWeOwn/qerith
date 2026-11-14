// The identity integration must provide drive_active_members(id), backed by live
// membership state. An absent view fails closed; a session is not membership.
interface Statement {
  bind(...values: (string | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

export interface ListCursor { name: string; id: string }
export interface ListedEntry extends Entry { item_count: number | null }
export interface EntryPage { entries: ListedEntry[]; nextCursor: ListCursor | null }

export interface Entry {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  kind: 'file' | 'folder';
}

const columns = 'id, owner_id, parent_id, name, kind';
const active = 'EXISTS (SELECT 1 FROM drive_active_members WHERE id = ?)';

function validateName(name: string): void {
  if (typeof name !== 'string' || Array.from(name).length < 1 || Array.from(name).length > 255 || /[\/\0]/.test(name)) {
    throw new TypeError('Invalid entry name');
  }
}

// This service accepts only a server-authenticated principal ID. It never grants
// access through an owner role, an object key, or a client-supplied owner ID.
export class PrivateMetadata {
  private readonly db: Database;

  constructor(db: Database) { this.db = db; }

  async get(principalId: string, id: string): Promise<Entry | null> {
    return this.db.prepare(`SELECT ${columns} FROM drive_entries
      WHERE id = ? AND owner_id = ? AND ${active}`)
      .bind(id, principalId, principalId).first<Entry>();
  }

  async list(principalId: string, parentId: string | null, cursor: ListCursor | null = null): Promise<EntryPage> {
    const result = await this.db.prepare(`SELECT ${columns},
      CASE WHEN kind = 'folder' THEN (SELECT COUNT(*) FROM drive_entries child
        WHERE child.owner_id = drive_entries.owner_id AND child.parent_id = drive_entries.id)
        ELSE NULL END AS item_count
      FROM drive_entries
      WHERE owner_id = ? AND parent_id IS ? AND ${active}
        AND (? IS NULL OR name > ? OR (name = ? AND id > ?))
      ORDER BY name, id LIMIT 101`).bind(principalId, parentId, principalId,
        cursor?.name ?? null, cursor?.name ?? null, cursor?.name ?? null, cursor?.id ?? null).all<ListedEntry>();
    const entries = result.results.slice(0, 100);
    const last = entries[entries.length - 1];
    return { entries, nextCursor: result.results.length > 100 ? { name: last.name, id: last.id } : null };
  }

  // Only completed files have metadata rows. Return decimal text to avoid JS precision loss.
  async usage(principalId: string): Promise<{ bytes: string } | null> {
    return this.db.prepare(`SELECT CAST(COALESCE(SUM(size_bytes), 0) AS TEXT) AS bytes
      FROM drive_entries WHERE owner_id = ? AND kind = 'file' AND ${active}
      HAVING ${active}`).bind(principalId, principalId, principalId).first<{ bytes: string }>();
  }

  async createFolder(principalId: string, parentId: string | null, name: string): Promise<Entry | null> {
    validateName(name);
    return this.db.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind)
      SELECT ?, ?, ?, ?, 'folder' WHERE ${active}
      RETURNING ${columns}`).bind(crypto.randomUUID(), principalId, parentId, name, principalId).first<Entry>();
  }

  async move(principalId: string, id: string, parentId: string | null, name: string): Promise<Entry | null> {
    validateName(name);
    return this.db.prepare(`UPDATE drive_entries SET parent_id = ?, name = ?
      WHERE id = ? AND owner_id = ? AND ${active}
      RETURNING ${columns}`).bind(parentId, name, id, principalId, principalId).first<Entry>();
  }
}
