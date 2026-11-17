// Server-only reconciliation records. Authenticate the principal before calling;
// an intent does not publish a file.
interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

type State = 'created' | 'initiating' | 'allocated' | 'completing' | 'uncertain' | 'acknowledged';
export interface UploadIntent {
  id: string;
  owner_id: string;
  object_key: string;
  upload_id: string | null;
  state: State;
  completion_acknowledged: number;
  version: number;
}

const columns = 'id, owner_id, object_key, upload_id, completion_acknowledged, state, version';
const active = 'EXISTS (SELECT 1 FROM drive_active_members WHERE id = ?)';

export class UploadIntents {
  constructor(private readonly db: Database) {}

  async create(principalId: string): Promise<UploadIntent | null> {
    return this.db.prepare(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state)
      SELECT ?, ?, ?, 'created' WHERE ${active} RETURNING ${columns}`)
      .bind(crypto.randomUUID(), principalId, crypto.randomUUID(), principalId).first<UploadIntent>();
  }

  async get(principalId: string, id: string): Promise<UploadIntent | null> {
    return this.db.prepare(`SELECT ${columns} FROM drive_upload_intents
      WHERE id = ? AND owner_id = ? AND ${active}`)
      .bind(id, principalId, principalId).first<UploadIntent>();
  }

  // Trusted reconciliation only; never expose this scan to a principal. Restart
  // from the beginning because revocation or late evidence may occur behind the
  // cursor. A scan result alone does not authorize deletion or provider operations.
  async listRevokedEvidence(afterId: string, limit: number): Promise<UploadIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid recovery limit');
    const page = await this.db.prepare(`SELECT ${columns} FROM drive_upload_intents
      WHERE state IN ('allocated', 'acknowledged') AND id > ?
        AND NOT EXISTS (SELECT 1 FROM drive_active_members WHERE id = owner_id)
      ORDER BY id LIMIT ?`).bind(afterId, limit).all<UploadIntent>();
    return page.results;
  }
}
