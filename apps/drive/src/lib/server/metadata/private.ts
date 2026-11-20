// Identity integration must supply drive_active_members(id) from live membership.
// This service accepts a server-authenticated principal, not a client owner ID.
interface Statement {
  bind(...values: (string | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

export interface Entry {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  kind: 'file' | 'folder';
}

export interface Cursor { name: string; id: string }
export interface ListedEntry extends Entry { item_count: number | null }
export interface Page { entries: ListedEntry[]; nextCursor: Cursor | null }
type RootEntry = Pick<Entry, 'id' | 'name' | 'kind'>;
interface RootPage { entries: RootEntry[]; nextCursor: string | null }
type RootRead = RootPage | 'invalid-page' | null;

const columns = 'id, owner_id, parent_id, name, kind';
const active = 'EXISTS (SELECT 1 FROM drive_active_members WHERE id = ?)';

// Append to an existing authorization statement, not a prior role snapshot.
export function requireActiveOwner(required: boolean, principal: 's.principal_id' | 'i.owner_id' | 'o.owner_id' | 'c.owner_id' | 'e.owner_id') {
  return required ? `AND EXISTS (SELECT 1 FROM drive_principals p WHERE p.id = ${principal} AND p.status = 'active' AND p.role = 'owner')` : '';
}

export function validateName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('Invalid entry name');
  let bytes = 0;
  let meaningful = false;
  for (const character of name) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > 255 || character === '/' || code === 0 || (code >= 0xd800 && code <= 0xdfff)) {
      throw new TypeError('Invalid entry name');
    }
    if (character !== ' ' && character !== '.') meaningful = true;
  }
  if (!meaningful) throw new TypeError('Invalid entry name');
}

export class PrivateMetadata {
  private readonly db: Database;

  constructor(db: Database) { this.db = db; }

  async get(principalId: string, id: string): Promise<Entry | null> {
    return this.db.prepare(`SELECT ${columns} FROM drive_entries
      WHERE id = ? AND owner_id = ? AND ${active}`)
      .bind(id, principalId, principalId).first<Entry>();
  }

  list(principalId: string, parentId: null, cursor: string | null, sessionHash: string, ownerOnly?: boolean): Promise<RootRead>;
  list(principalId: string, parentId: string | null, cursor?: Cursor | null): Promise<Page>;
  async list(principalId: string, parentId: string | null, cursor: Cursor | string | null = null,
    sessionHash?: string, ownerOnly = false): Promise<Page | RootRead> {
    if (sessionHash !== undefined) {
      if (parentId !== null || (cursor !== null && typeof cursor !== 'string')) throw new TypeError('Invalid root listing');
      return this.listSessionRoot(principalId, cursor, sessionHash, ownerOnly);
    }
    if (cursor !== null && (typeof cursor !== 'object' || typeof cursor.name !== 'string' || typeof cursor.id !== 'string')) {
      throw new TypeError('Invalid cursor');
    }
    const boundary = cursor === null ? '' : 'AND (name, id) > (?, ?)';
    const query = this.db.prepare(`SELECT ${columns},
      (SELECT item_count FROM drive_folder_counts WHERE folder_id = drive_entries.id) AS item_count FROM drive_entries
      WHERE owner_id = ? AND COALESCE(parent_id, '') = COALESCE(?, '') AND ${active}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM drive_entries AS parent
          WHERE parent.id = ? AND parent.owner_id = ? AND parent.kind = 'folder'))
        ${boundary} ORDER BY name, id LIMIT 101`);
    const values = [principalId, parentId, principalId, parentId, parentId, principalId];
    if (cursor !== null) values.push(cursor.name, cursor.id);
    const rows = (await query.bind(...values).all<ListedEntry>()).results;
    const entries = rows.slice(0, 100);
    const last = entries[entries.length - 1];
    return { entries, nextCursor: rows.length > 100 ? { name: last.name, id: last.id } : null };
  }

  private async listSessionRoot(principalId: string, cursor: string | null, sessionHash: string, ownerOnly: boolean): Promise<RootRead> {
    const limit = 'ORDER BY kind DESC, name COLLATE BINARY ASC, id ASC LIMIT 101';
    const root = 'owner_id = (SELECT principal_id FROM authorized) AND parent_id IS NULL';
    const entries = `SELECT id, name, kind FROM drive_entries INDEXED BY drive_entries_listing_asc WHERE ${root}`;
    // Resolve the cursor within the same authorized read; keep the name out of the URL.
    const ranges = cursor === null ? `children AS (${entries} ${limit})` : `boundary AS (
      SELECT name, kind FROM drive_entries WHERE id = ? AND ${root}
    ), same_kind AS (
      ${entries} AND kind = (SELECT kind FROM boundary) AND name COLLATE BINARY > (SELECT name FROM boundary) ${limit}
    ), later_kind AS (
      ${entries} AND kind < (SELECT kind FROM boundary) ${limit}
    ), children AS (
      SELECT * FROM (SELECT * FROM same_kind UNION ALL SELECT * FROM later_kind) ${limit}
    )`;
    // A sentinel distinguishes an authorized empty or stale page from a denied read.
    const invalidPage = cursor === null ? '0' : 'NOT EXISTS (SELECT 1 FROM boundary)';
    const { results } = await this.db.prepare(`WITH authorized AS (
      SELECT s.principal_id FROM drive_sessions s JOIN drive_active_members m ON m.id = s.principal_id
      WHERE s.principal_id = ? AND s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        ${requireActiveOwner(ownerOnly, 's.principal_id')}
    ), ${ranges} SELECT id, name, kind, 0 AS invalid_page FROM children
      UNION ALL SELECT NULL, NULL, NULL, ${invalidPage} FROM authorized ORDER BY kind DESC, name, id`)
      .bind(principalId, sessionHash, ...(cursor === null ? [] : [cursor]))
      .all<RootEntry | { id: null; name: null; kind: null; invalid_page: number }>();
    const sentinel = results.find(row => row.id === null);
    if (!sentinel) return null;
    if (sentinel.invalid_page) return 'invalid-page';
    const items = results.filter((row): row is RootEntry => row.id !== null);
    return { entries: items.slice(0, 100), nextCursor: items.length > 100 ? items[99].id : null };
  }

  // Decimal text preserves precision beyond JavaScript's safe integer range.
  async usage(principalId: string): Promise<{ bytes: string } | null> {
    const result = await this.db.prepare(`SELECT CAST(COALESCE(high, 0) AS TEXT) ||
      printf('%09d', COALESCE(low, 0)) AS bytes
      FROM (SELECT 1) LEFT JOIN drive_owner_usage ON owner_id = ?
      WHERE ${active}`).bind(principalId, principalId).first<{ bytes: string }>();
    return result === null ? null : { bytes: result.bytes.replace(/^0+(?=\d)/, '') };
  }

  async move(principalId: string, id: string, parentId: string | null, name: string): Promise<Entry | null> {
    validateName(name);
    return this.db.prepare(`UPDATE drive_entries SET parent_id = ?, name = ?
      WHERE id = ? AND owner_id = ? AND ${active}
      RETURNING ${columns}`).bind(parentId, name, id, principalId, principalId).first<Entry>();
  }

  async createFolder(principalId: string, parentId: string | null, name: string): Promise<Entry | null> {
    validateName(name);
    return this.db.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind)
      SELECT ?, ?, ?, ?, 'folder' WHERE ${active}
      RETURNING ${columns}`).bind(crypto.randomUUID(), principalId, parentId, name, principalId).first<Entry>();
  }
}
