interface Statement {
  bind(...values: (string | number | ArrayBuffer)[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Session { prepare(sql: string): Statement }
interface Database extends Session { withSession(constraint: 'first-primary'): Session }

export interface UploadCompletionOperation {
  operationId: string;
  intentId: string;
  ownerId: string;
  objectKey: string;
  storageEpoch: string;
  uploadId: string;
  intentVersion: number;
}

function identity(op: UploadCompletionOperation): [string, string, string, string, string, string, number] {
  return [op.operationId, op.intentId, op.ownerId, op.objectKey, op.storageEpoch, op.uploadId, op.intentVersion];
}
const exactOperation = `o.operation_id = ? AND o.intent_id = ? AND o.owner_id = ? AND o.object_key = ?
  AND o.storage_epoch = ? AND o.upload_id = ? AND o.intent_version = ?`;

function receiptBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteLength < 1 || bytes.byteLength > 64 * 1024) throw new TypeError('Invalid completion evidence size');
  return new Uint8Array(bytes).buffer;
}

// Unwired, server-only evidence storage. An operation row is not a dispatch claim;
// even exact receipt bytes do not establish provider provenance or live authority.
export class UploadOperationEvidence {
  constructor(private readonly db: Database) {}

  async recordOperation(op: UploadCompletionOperation): Promise<void> {
    await this.db.prepare(`INSERT INTO drive_upload_completion_operations
      (operation_id, intent_id, owner_id, object_key, storage_epoch, upload_id, intent_version)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING operation_id`).bind(...identity(op)).first();
  }

  async storeUnverifiedReceipt(op: UploadCompletionOperation, bytes: Uint8Array): Promise<void> {
    const row = await this.db.prepare(`INSERT INTO drive_upload_completion_evidence (operation_id, receipt_bytes)
      SELECT o.operation_id, ? FROM drive_upload_completion_operations o WHERE ${exactOperation}
      RETURNING operation_id`).bind(receiptBuffer(bytes), ...identity(op)).first();
    if (!row) throw new Error('No matching upload completion operation');
  }

  // Reconcile a lost D1 acknowledgement using the exact bytes still held by the
  // caller. Read on a fresh primary session, not a cached or replica observation.
  // If the bytes are gone, this slice offers no way to recover provider success.
  async reconcileReceiptWrite(op: UploadCompletionOperation, bytes: Uint8Array): Promise<'recorded' | 'conflict' | 'unknown'> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT
      CASE WHEN e.receipt_bytes = ? THEN 1 ELSE 0 END AS matches
      FROM drive_upload_completion_operations o JOIN drive_upload_completion_evidence e USING (operation_id)
      WHERE ${exactOperation}`).bind(receiptBuffer(bytes), ...identity(op)).first<{ matches: number }>();
    if (!row) return 'unknown';
    return row.matches === 1 ? 'recorded' : 'conflict';
  }
}
