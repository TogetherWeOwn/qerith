// Server-only reconciliation records. The caller must authenticate the principal;
// neither an intent nor an acknowledged provider response publishes a file.
interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Database { prepare(sql: string): Statement }

type State = 'initiating' | 'allocated' | 'completing' | 'uncertain' | 'acknowledged';
export interface UploadIntent {
  id: string;
  owner_id: string;
  object_key: string;
  upload_id: string | null;
  state: State;
  version: number;
}

const columns = 'id, owner_id, object_key, upload_id, state, version';
const active = 'EXISTS (SELECT 1 FROM drive_active_members WHERE id = ?)';

export class UploadIntents {
  constructor(private readonly db: Database) {}

  async create(principalId: string): Promise<UploadIntent | null> {
    const id = crypto.randomUUID();
    return this.db.prepare(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state)
      SELECT ?, ?, ?, 'initiating' WHERE ${active} RETURNING ${columns}`)
      .bind(id, principalId, crypto.randomUUID(), principalId).first<UploadIntent>();
  }

  async get(principalId: string, id: string): Promise<UploadIntent | null> {
    return this.db.prepare(`SELECT ${columns} FROM drive_upload_intents
      WHERE id = ? AND owner_id = ? AND ${active}`)
      .bind(id, principalId, principalId).first<UploadIntent>();
  }

  async transition(principalId: string, id: string, version: number,
    from: State, to: State, uploadId: string | null = null): Promise<UploadIntent | null> {
    const allowed = (from === 'initiating' && (to === 'allocated' || to === 'uncertain'))
      || (from === 'allocated' && to === 'completing')
      || (from === 'completing' && (to === 'uncertain' || to === 'acknowledged'));
    if (!allowed || !Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER
      || (to === 'allocated' ? typeof uploadId !== 'string' || uploadId.length === 0 || uploadId.length > 2048 : uploadId !== null)) {
      throw new TypeError('Invalid upload transition');
    }
    return this.db.prepare(`UPDATE drive_upload_intents
      SET state = ?, upload_id = COALESCE(?, upload_id), version = version + 1
      WHERE id = ? AND owner_id = ? AND state = ? AND version = ? AND ${active}
      RETURNING ${columns}`).bind(to, uploadId, id, principalId, from, version, principalId).first<UploadIntent>();
  }
}
