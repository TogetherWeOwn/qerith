// Server-only reconciliation records. Authenticate the principal before calling;
// neither an intent nor a provider acknowledgement publishes a file.
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

function validateVersion(version: number): void {
  // Reserve a version for recording an uncertain outcome and one for late evidence.
  if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER - 1) {
    throw new TypeError('Invalid upload version');
  }
}

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

  // A successful claim authorizes one provider attempt. A stale claim never does.
  async claim(principalId: string, id: string, version: number,
    operation: 'allocation' | 'completion'): Promise<UploadIntent | null> {
    validateVersion(version);
    if (operation !== 'allocation' && operation !== 'completion') throw new TypeError('Invalid upload operation');
    // A claim must leave room for uncertainty and its eventual late evidence.
    if (version >= Number.MAX_SAFE_INTEGER - 2) throw new TypeError('Invalid upload version');
    return this.db.prepare(`UPDATE drive_upload_intents SET state = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND state = ? AND version = ? AND ${active}
      RETURNING ${columns}`)
      .bind(operation === 'allocation' ? 'initiating' : 'completing', id, principalId,
        operation === 'allocation' ? 'created' : 'allocated', version, principalId).first<UploadIntent>();
  }

  // The following methods are trusted provider-operation code only. Their arguments
  // must come from the successful claim, never directly from a request. They record
  // outcomes after revocation without returning reconciliation data to the caller.
  async recordUncertain(ownerId: string, id: string, version: number,
    operation: 'allocation' | 'completion'): Promise<boolean> {
    validateVersion(version);
    if (operation !== 'allocation' && operation !== 'completion') throw new TypeError('Invalid upload operation');
    const row = await this.db.prepare(`UPDATE drive_upload_intents SET state = 'uncertain', version = version + 1
      WHERE id = ? AND owner_id = ? AND state = ? AND version = ? RETURNING id`)
      .bind(id, ownerId, operation === 'allocation' ? 'initiating' : 'completing', version).first<{ id: string }>();
    return row !== null;
  }

  // Retry is safe only if the provider request was definitely never dispatched.
  // A timeout, error response, crash or unknown outcome must use recordUncertain.
  async recordNotDispatched(ownerId: string, id: string, version: number,
    operation: 'allocation' | 'completion'): Promise<boolean> {
    validateVersion(version);
    if (operation !== 'allocation' && operation !== 'completion') throw new TypeError('Invalid upload operation');
    const row = await this.db.prepare(`UPDATE drive_upload_intents SET state = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND state = ? AND version = ? RETURNING id`)
      .bind(operation === 'allocation' ? 'created' : 'allocated', id, ownerId,
        operation === 'allocation' ? 'initiating' : 'completing', version).first<{ id: string }>();
    return row !== null;
  }

  async recordSuccess(ownerId: string, id: string, version: number,
    result: { kind: 'allocation'; uploadId: string } | { kind: 'completion' }): Promise<boolean> {
    validateVersion(version);
    if (!result || (result.kind !== 'allocation' && result.kind !== 'completion')
      || (result.kind === 'allocation' && (typeof result.uploadId !== 'string'
        || result.uploadId.length === 0 || result.uploadId.length > 65536))) {
      throw new TypeError('Invalid provider outcome');
    }
    const allocation = result.kind === 'allocation';
    const row = await this.db.prepare(`UPDATE drive_upload_intents
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
    return row !== null;
  }
}
