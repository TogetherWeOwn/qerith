// Identity integration must supply drive_active_members(id) from live membership.
// This service accepts a server-authenticated principal, not a client owner ID.
interface Statement {
  bind(...values: (string | null)[]): Statement;
  first<T>(): Promise<T | null>;
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

function validateName(name: string): void {
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

  async createFolder(principalId: string, parentId: string | null, name: string): Promise<Entry | null> {
    validateName(name);
    return this.db.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind)
      SELECT ?, ?, ?, ?, 'folder' WHERE ${active}
      RETURNING ${columns}`).bind(crypto.randomUUID(), principalId, parentId, name, principalId).first<Entry>();
  }
}
