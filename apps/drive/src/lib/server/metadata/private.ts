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
      CASE WHEN kind = 'folder' THEN (SELECT item_count FROM drive_folder_counts
        WHERE folder_id = drive_entries.id) ELSE NULL END AS item_count
      FROM drive_entries
      WHERE owner_id = ? AND parent_id IS ? AND ${active}
        ${cursor ? 'AND (name, id) > (?, ?)' : ''}
      ORDER BY name, id LIMIT 101`).bind(principalId, parentId, principalId,
        ...(cursor ? [cursor.name, cursor.id] : [])).all<ListedEntry>();
    const entries = result.results.slice(0, 100);
    const last = entries[entries.length - 1];
    return { entries, nextCursor: result.results.length > 100 ? { name: last.name, id: last.id } : null };
  }

  // Decimal text preserves precision beyond JavaScript's safe integer range.
  async usage(principalId: string): Promise<{ bytes: string } | null> {
    return this.db.prepare(`SELECT CAST(COALESCE(high, 0) AS TEXT) ||
        printf('%09d', COALESCE(low, 0)) AS bytes
      FROM (SELECT 1) LEFT JOIN drive_owner_usage ON owner_id = ?
      WHERE ${active}`).bind(principalId, principalId).first<{ bytes: string }>()
      .then(result => result === null ? null : { bytes: result.bytes.replace(/^0+(?=\d)/, '') });
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
