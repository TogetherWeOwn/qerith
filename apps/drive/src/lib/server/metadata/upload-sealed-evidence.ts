import type { UploadCompletionOperation } from './upload-operation-evidence';

interface Statement {
  bind(...values: (string | number | ArrayBuffer)[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Session { prepare(sql: string): Statement }
interface Database extends Session { withSession(constraint: 'first-primary'): Session }

type Identity = string | Uint8Array;
type Operation = { [K in keyof UploadCompletionOperation]: UploadCompletionOperation[K] extends string ? Identity : number };
interface Snapshot {
  operation: Operation;
  partNumbers: readonly number[];
  sizeBytes: number;
}
type Reconciliation = 'recorded' | 'conflict' | 'unknown';

const utf8 = new TextEncoder();
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!;
function copyBytes(bytes: Uint8Array, limit: number, message: string): ArrayBuffer {
  if (typedArrayTag.call(bytes) !== 'Uint8Array') throw new TypeError(message);
  const size: number = Reflect.get(Uint8Array.prototype, 'byteLength', bytes);
  if (size < 1 || size > limit) throw new TypeError(message);
  return new Uint8Array(bytes).buffer;
}
function text(value: Identity): ArrayBuffer {
  const message = 'Invalid sealed upload identity';
  // Match SQLite TEXT without replacing inherited bytes or lone surrogates.
  if (typeof value !== 'string') return copyBytes(value, 196608, message);
  if (value.length < 1 || value.length > 196608 || /[\uD800-\uDFFF]/u.test(value)) throw new TypeError(message);
  const bytes = utf8.encode(value);
  if (bytes.byteLength > 196608) throw new TypeError(message);
  return bytes.buffer;
}
function identity(op: Operation): (number | ArrayBuffer)[] {
  const { operationId, intentId, ownerId, objectKey, storageEpoch, uploadId, intentVersion } = op;
  if (!Number.isSafeInteger(intentVersion) || intentVersion < 0) throw new TypeError('Invalid sealed upload identity');
  return [text(operationId), text(intentId), text(ownerId), text(objectKey), text(storageEpoch), text(uploadId), intentVersion];
}
const exactOperation = `o.operation_id = CAST(? AS TEXT) AND o.intent_id = CAST(? AS TEXT) AND o.owner_id = CAST(? AS TEXT)
  AND o.object_key = CAST(? AS TEXT) AND o.storage_epoch = CAST(? AS TEXT) AND o.upload_id = CAST(? AS TEXT) AND o.intent_version = ?`;
const fromSnapshot = `FROM drive_upload_completion_operations o JOIN drive_upload_sealed_snapshots s USING (operation_id)`;
const exactSnapshot = 's.part_numbers = ? AND s.size_bytes = ?';

function slots(parts: readonly number[], size: number): string {
  if (!Array.isArray(parts) || !Number.isSafeInteger(size) || size < 0 || size > 167772160000) {
    throw new TypeError('Invalid sealed upload snapshot');
  }
  const count = parts.length;
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new TypeError('Invalid sealed upload part count');
  const numbers: number[] = [];
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const number = parts[i];
    if (!Number.isInteger(number) || number <= previous || number > 10_000) throw new TypeError('Invalid sealed upload part order');
    numbers.push(number);
    previous = number;
  }
  return JSON.stringify(numbers);
}

// Unwired server-only storage. Sealing fixes a historical set of observations;
// it does not settle provider writes, create a receipt or grant live authority.
export class UploadSealedEvidence {
  constructor(private readonly db: Database) {}

  async recordSnapshot({ operation, partNumbers, sizeBytes }: Snapshot): Promise<void> {
    const row = await this.db.prepare(`INSERT INTO drive_upload_sealed_snapshots (operation_id, part_numbers, size_bytes)
      SELECT o.operation_id, ?, ? FROM drive_upload_completion_operations o WHERE ${exactOperation}
      RETURNING operation_id`).bind(slots(partNumbers, sizeBytes), sizeBytes, ...identity(operation)).first();
    if (!row) throw new Error('No matching upload completion operation');
  }

  async recordUnverifiedReport({ operation, partNumbers, sizeBytes }: Snapshot, report: Uint8Array): Promise<void> {
    const row = await this.db.prepare(`INSERT INTO drive_upload_sealed_reports (operation_id, report_bytes)
      SELECT o.operation_id, ? ${fromSnapshot} WHERE ${exactOperation} AND ${exactSnapshot} RETURNING operation_id`)
      .bind(copyBytes(report, 65536, 'Invalid sealed upload report'), ...identity(operation), slots(partNumbers, sizeBytes), sizeBytes).first();
    if (!row) throw new Error('No matching sealed upload snapshot');
  }

  // An exact primary read only answers whether the original D1 write committed.
  // Absence or an unavailable primary cannot justify a provider retry.
  async reconcileSnapshotWrite({ operation, partNumbers, sizeBytes }: Snapshot): Promise<Reconciliation> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT (${exactSnapshot}) AS matches
      ${fromSnapshot} WHERE ${exactOperation}`).bind(slots(partNumbers, sizeBytes), sizeBytes, ...identity(operation))
      .first<{ matches: number }>();
    return !row ? 'unknown' : row.matches === 1 ? 'recorded' : 'conflict';
  }

  async reconcileReportWrite({ operation, partNumbers, sizeBytes }: Snapshot, report: Uint8Array): Promise<Reconciliation> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT (r.report_bytes = ?) AS matches
      ${fromSnapshot} JOIN drive_upload_sealed_reports r USING (operation_id)
      WHERE ${exactOperation} AND ${exactSnapshot}`).bind(copyBytes(report, 65536, 'Invalid sealed upload report'), ...identity(operation),
      slots(partNumbers, sizeBytes), sizeBytes).first<{ matches: number }>();
    return !row ? 'unknown' : row.matches === 1 ? 'recorded' : 'conflict';
  }
}
