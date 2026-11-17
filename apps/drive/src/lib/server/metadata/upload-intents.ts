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

  // Trusted reconciliation only; restart scans from the beginning to find rows
  // claimed behind the cursor. A scan is not a lease and never permits a retry.
  async listInFlight(afterId: string, limit: number): Promise<UploadIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid recovery limit');
    const page = await this.db.prepare(`SELECT ${columns} FROM drive_upload_intents
      WHERE state IN ('initiating', 'completing') AND id > ? ORDER BY id LIMIT ?`)
      .bind(afterId, limit).all<UploadIntent>();
    return page.results;
  }

  // Include revoked owners. For rows quarantined by the transition protocol,
  // upload_id distinguishes completion from allocation and the original claim
  // version is version - 1 (quarantine increments it). Restart after interruption.
  async listUncertain(afterId: string, limit: number): Promise<UploadIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid recovery limit');
    const page = await this.db.prepare(`SELECT ${columns} FROM drive_upload_intents
      WHERE state = 'uncertain' AND id > ? ORDER BY id LIMIT ?`)
      .bind(afterId, limit).all<UploadIntent>();
    return page.results;
  }

  // Trusted provider-operation or recovery code only: arguments must come from a
  // successful claim or trusted scan, never directly from a request. Recovery can
  // quarantine after revocation, but it never authorizes a provider retry.
  async recordUncertain(ownerId: string, id: string, version: number,
    operation: 'allocation' | 'completion'): Promise<boolean> {
    validateVersion(version);
    if (operation !== 'allocation' && operation !== 'completion') throw new TypeError('Invalid upload operation');
    const row = await this.db.prepare(`UPDATE drive_upload_intents SET state = 'uncertain', version = version + 1
      WHERE id = ? AND owner_id = ? AND state = ? AND version = ? RETURNING id`)
      .bind(id, ownerId, operation === 'allocation' ? 'initiating' : 'completing', version).first<{ id: string }>();
    return row !== null;
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
