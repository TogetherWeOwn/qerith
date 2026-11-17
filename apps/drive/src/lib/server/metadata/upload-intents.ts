// Server-only reconciliation records. The caller must authenticate the principal;
// neither an intent nor an acknowledged provider response publishes a file.
interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
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
    const id = crypto.randomUUID();
    return this.db.prepare(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state)
      SELECT ?, ?, ?, 'created' WHERE ${active} RETURNING ${columns}`)
      .bind(id, principalId, crypto.randomUUID(), principalId).first<UploadIntent>();
  }

  async get(principalId: string, id: string): Promise<UploadIntent | null> {
    return this.db.prepare(`SELECT ${columns} FROM drive_upload_intents
      WHERE id = ? AND owner_id = ? AND ${active}`)
      .bind(id, principalId, principalId).first<UploadIntent>();
  }

  // Only the caller that wins created -> initiating may start allocation. Never
  // retry an initiating operation: a crashed caller may have reached the provider.
  async transition(principalId: string, id: string, version: number,
    from: State, to: State, uploadId: string | null = null): Promise<UploadIntent | null> {
    const allowed = (from === 'created' && to === 'initiating')
      || (from === 'initiating' && (to === 'allocated' || to === 'uncertain'))
      || (from === 'allocated' && to === 'completing')
      || (from === 'completing' && (to === 'uncertain' || to === 'acknowledged'));
    if (!allowed || !Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER
      || (to === 'allocated' ? typeof uploadId !== 'string' || uploadId.length === 0 || uploadId.length > 65536 : uploadId !== null)) {
      throw new TypeError('Invalid upload transition');
    }
    return this.db.prepare(`UPDATE drive_upload_intents
      SET state = ?, upload_id = COALESCE(?, upload_id),
        completion_acknowledged = CASE WHEN ? = 'acknowledged' THEN 1 ELSE completion_acknowledged END,
        version = version + 1
      WHERE id = ? AND owner_id = ? AND state = ? AND version = ? AND ${active}
      RETURNING ${columns}`).bind(to, uploadId, to, id, principalId, from, version, principalId).first<UploadIntent>();
  }

  // Trusted provider-operation code only: never expose these methods to a user or
  // accept their arguments from a request. They must be called only for an
  // operation started while the owner was active.
  async recordProviderUncertainty(ownerId: string, id: string, version: number,
    operation: 'allocation' | 'completion'): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER - 1
      || (operation !== 'allocation' && operation !== 'completion')) {
      throw new TypeError('Invalid provider outcome');
    }
    await this.db.prepare(`UPDATE drive_upload_intents SET state = 'uncertain', version = version + 1
      WHERE id = ? AND owner_id = ? AND state = ? AND version = ? RETURNING id`)
      .bind(id, ownerId, operation === 'allocation' ? 'initiating' : 'completing', version)
      .first<{ id: string }>();
  }

  // Trusted provider-operation code only: never expose this method to a user or
  // accept its arguments from a request. It records evidence without returning
  // the intent, including after revocation or an uncertainty transition.
  async recordProviderSuccess(ownerId: string, id: string, version: number,
    result: { kind: 'allocation'; uploadId: string } | { kind: 'completion' }): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER - 1
      || (result.kind !== 'allocation' && result.kind !== 'completion')
      || (result.kind === 'allocation' && (typeof result.uploadId !== 'string'
        || result.uploadId.length === 0 || result.uploadId.length > 65536))) {
      throw new TypeError('Invalid provider outcome');
    }
    const allocation = result.kind === 'allocation';
    await this.db.prepare(`UPDATE drive_upload_intents
      SET state = CASE WHEN state = 'uncertain' THEN state ELSE ? END,
        upload_id = COALESCE(?, upload_id),
        completion_acknowledged = CASE WHEN ? = 'completion' THEN 1 ELSE completion_acknowledged END,
        version = version + 1
      WHERE id = ? AND owner_id = ? AND version < 9007199254740991
        AND ((state = ? AND version = ?) OR (state = 'uncertain' AND version = ?))
        AND ${allocation ? 'upload_id IS NULL' : 'upload_id IS NOT NULL AND completion_acknowledged = 0'}
      RETURNING id`)
      .bind(allocation ? 'allocated' : 'acknowledged', allocation ? result.uploadId : null,
        result.kind, id, ownerId, allocation ? 'initiating' : 'completing', version, version + 1)
      .first<{ id: string }>();
  }
}
