interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Session { prepare(sql: string): Statement }
interface Database extends Session { withSession(constraint: 'first-primary'): Session }

export interface UploadPartOperation {
  operationId: string;
  intentId: string;
  ownerId: string;
  objectKey: string;
  storageEpoch: string;
  uploadId: string;
  intentVersion: number;
  partNumber: number;
  sizeBytes: number;
}

// D1 binds UTF-8 text; reject lone surrogates rather than comparing their replacements.
const isText = (value: string) => typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value);
function identity(op: UploadPartOperation): (string | number)[] {
  const text = [op.operationId, op.intentId, op.ownerId, op.objectKey, op.storageEpoch, op.uploadId];
  const numbers = [op.intentVersion, op.partNumber, op.sizeBytes];
  if (!text.every(isText) || !numbers.every(Number.isSafeInteger)) throw new TypeError('Invalid upload part identity');
  return [...text, ...numbers];
}
const exactOperation = `o.operation_id = ? AND o.intent_id = ? AND o.owner_id = ? AND o.object_key = ?
  AND o.storage_epoch = ? AND o.upload_id = ? AND o.intent_version = ? AND o.part_number = ? AND o.size_bytes = ?`;
function kind(reportedEtag: string | null): 'uncertain' | 'reported' {
  if (reportedEtag === null) return 'uncertain';
  if (!isText(reportedEtag) || reportedEtag.length < 1 || reportedEtag.length > 1024
      || new TextEncoder().encode(reportedEtag).length > 1024) throw new TypeError('Invalid reported part ETag');
  return 'reported';
}

// Unwired server-side ledger. A recorded admission is a snapshot, not a claim
// to dispatch. Observations are unverified, including their association with bytes.
export class UploadPartOperationEvidence {
  constructor(private readonly db: Database) {}

  async recordAdmission(op: UploadPartOperation): Promise<void> {
    const row = await this.db.prepare(`INSERT INTO drive_upload_part_operations
      (operation_id, intent_id, owner_id, object_key, storage_epoch, upload_id, intent_version, part_number, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING operation_id`).bind(...identity(op)).first();
    if (!row) throw new Error('No upload part admission recorded');
  }

  // Null records uncertainty. Non-null records only what the caller reported.
  async recordObservation(op: UploadPartOperation, reportedEtag: string | null): Promise<void> {
    const row = await this.db.prepare(`INSERT INTO drive_upload_part_observations (operation_id, kind, reported_etag)
      SELECT o.operation_id, ?, ? FROM drive_upload_part_operations o WHERE ${exactOperation}
      RETURNING operation_id`).bind(kind(reportedEtag), reportedEtag, ...identity(op)).first();
    if (!row) throw new Error('No matching upload part operation');
  }

  // Lost D1 acknowledgement is reconciled by exact identity on a fresh primary.
  // No read result (including absence) is permission to call the provider.
  async reconcileAdmissionWrite(op: UploadPartOperation): Promise<'recorded' | 'unknown'> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT o.operation_id
      FROM drive_upload_part_operations o WHERE ${exactOperation}`).bind(...identity(op)).first();
    return row ? 'recorded' : 'unknown';
  }

  async reconcileObservationWrite(op: UploadPartOperation, reportedEtag: string | null): Promise<'recorded' | 'conflict' | 'unknown'> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT (e.reported_etag IS ?) AS matches
      FROM drive_upload_part_operations o JOIN drive_upload_part_observations e ON e.operation_id = o.operation_id
      WHERE e.kind = ? AND ${exactOperation}`).bind(reportedEtag, kind(reportedEtag), ...identity(op))
      .first<{ matches: number }>();
    if (!row) return 'unknown';
    return row.matches === 1 ? 'recorded' : 'conflict';
  }
}
