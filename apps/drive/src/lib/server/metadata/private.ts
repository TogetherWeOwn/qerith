// The identity integration must provide drive_active_members(id), backed by live
// membership state. An absent view fails closed; a session is not membership.
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

const columns = 'id, owner_id, parent_id, name, kind';
const active = 'EXISTS (SELECT 1 FROM drive_active_members WHERE id = ?)';

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

  async list(principalId: string, parentId: string | null): Promise<Entry[]> {
    const result = await this.db.prepare(`SELECT ${columns} FROM drive_entries
      WHERE owner_id = ? AND parent_id IS ? AND ${active}
      ORDER BY name, id`).bind(principalId, parentId, principalId).all<Entry>();
    return result.results;
  }

  async createFolder(principalId: string, id: string, parentId: string | null, name: string): Promise<Entry | null> {
    try {
      return await this.db.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind)
        SELECT ?, ?, ?, ?, 'folder' WHERE ${active}
        RETURNING ${columns}`).bind(id, principalId, parentId, name, principalId).first<Entry>();
    } catch {
      // Constraints and inaccessible parents have the same outward result.
      return null;
    }
  }

  async move(principalId: string, id: string, parentId: string | null, name: string): Promise<Entry | null> {
    try {
      return await this.db.prepare(`UPDATE drive_entries SET parent_id = ?, name = ?
        WHERE id = ? AND owner_id = ? AND ${active}
        RETURNING ${columns}`).bind(parentId, name, id, principalId, principalId).first<Entry>();
    } catch {
      return null;
    }
  }
}
