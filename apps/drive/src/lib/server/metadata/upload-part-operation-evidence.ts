interface Statement {
  bind(...values: (string | number | ArrayBuffer | null)[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Session { prepare(sql: string): Statement }
interface Database extends Session { withSession(constraint: 'first-primary'): Session }

// Legacy SQLite TEXT can contain bytes that do not round-trip through a JS string.
// Supply those bytes as-is; SQL casts the binding back to TEXT without decoding it.
type InheritedIdentity = string | Uint8Array;

export interface UploadPartOperation {
  operationId: string;
  intentId: InheritedIdentity;
  ownerId: InheritedIdentity;
  objectKey: InheritedIdentity;
  storageEpoch: string;
  uploadId: InheritedIdentity;
  intentVersion: number;
  partNumber: number;
  sizeBytes: number;
}

// Reject lone surrogates rather than comparing their UTF-8 replacements.
const isText = (value: unknown): value is string => typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value);
const utf8 = new TextEncoder();
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!;
function copyBytes(value: Uint8Array, size: number): ArrayBuffer {
  const span = new Uint8Array(Reflect.get(Uint8Array.prototype, 'buffer', value),
    Reflect.get(Uint8Array.prototype, 'byteOffset', value), size);
  return new Uint8Array(span).buffer;
}
function inheritedIdentity(value: InheritedIdentity): ArrayBuffer {
  if (typeof value === 'string') {
    if (isText(value)) return utf8.encode(value).buffer;
  } else if (typedArrayTag.call(value) === 'Uint8Array') {
    return copyBytes(value, Reflect.get(Uint8Array.prototype, 'byteLength', value));
  }
  throw new TypeError('Invalid upload part identity');
}
function identity(op: UploadPartOperation): (string | number | ArrayBuffer)[] {
  const { operationId, intentId, ownerId, objectKey, storageEpoch, uploadId, intentVersion, partNumber, sizeBytes } = op;
  const numbers = [intentVersion, partNumber, sizeBytes];
  if (!isText(operationId) || !isText(storageEpoch) || !numbers.every(Number.isSafeInteger)) {
    throw new TypeError('Invalid upload part identity');
  }
  return [operationId, inheritedIdentity(intentId), inheritedIdentity(ownerId), inheritedIdentity(objectKey),
    storageEpoch, inheritedIdentity(uploadId), ...numbers];
}
const exactOperation = `o.operation_id = ? AND o.intent_id = CAST(? AS TEXT) AND o.owner_id = CAST(? AS TEXT)
  AND o.object_key = CAST(? AS TEXT) AND o.storage_epoch = ? AND o.upload_id = CAST(? AS TEXT)
  AND o.intent_version = ? AND o.part_number = ? AND o.size_bytes = ?`;
function observation(reportedEtag: Uint8Array | null): ['uncertain' | 'reported', ArrayBuffer | null] {
  if (reportedEtag === null) return ['uncertain', null];
  if (typedArrayTag.call(reportedEtag) !== 'Uint8Array') throw new TypeError('Invalid reported part ETag');
  const size: number = Reflect.get(Uint8Array.prototype, 'byteLength', reportedEtag);
  if (size < 1 || size > 8192) throw new TypeError('Invalid reported part ETag');
  return ['reported', copyBytes(reportedEtag, size)];
}

// Unwired server-side ledger. A recorded admission is a snapshot, not a claim
// to dispatch. Observations are unverified, including their association with bytes.
export class UploadPartOperationEvidence {
  constructor(private readonly db: Database) {}

  async recordAdmission(op: UploadPartOperation): Promise<void> {
    const row = await this.db.prepare(`INSERT INTO drive_upload_part_operations
      (operation_id, intent_id, owner_id, object_key, storage_epoch, upload_id, intent_version, part_number, size_bytes)
      VALUES (?, CAST(? AS TEXT), CAST(? AS TEXT), CAST(? AS TEXT), ?, CAST(? AS TEXT), ?, ?, ?)
      RETURNING operation_id`).bind(...identity(op)).first();
    if (!row) throw new Error('No upload part admission recorded');
  }

  // Null records uncertainty. Non-null stores opaque caller-supplied ETag bytes.
  async recordObservation(op: UploadPartOperation, reportedEtag: Uint8Array | null): Promise<void> {
    const row = await this.db.prepare(`INSERT INTO drive_upload_part_observations (operation_id, kind, reported_etag)
      SELECT o.operation_id, ?, ? FROM drive_upload_part_operations o WHERE ${exactOperation}
      RETURNING operation_id`).bind(...observation(reportedEtag), ...identity(op)).first();
    if (!row) throw new Error('No matching upload part operation');
  }

  // Lost D1 acknowledgement is reconciled by exact identity on a fresh primary.
  // No read result (including absence) is permission to call the provider.
  async reconcileAdmissionWrite(op: UploadPartOperation): Promise<'recorded' | 'unknown'> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT o.operation_id
      FROM drive_upload_part_operations o WHERE ${exactOperation}`).bind(...identity(op)).first();
    return row ? 'recorded' : 'unknown';
  }

  async reconcileObservationWrite(op: UploadPartOperation, reportedEtag: Uint8Array | null): Promise<'recorded' | 'conflict' | 'unknown'> {
    const [kind, bytes] = observation(reportedEtag);
    const row = await this.db.withSession('first-primary').prepare(`SELECT (e.reported_etag IS ?) AS matches
      FROM drive_upload_part_operations o JOIN drive_upload_part_observations e ON e.operation_id = o.operation_id
      WHERE e.kind = ? AND ${exactOperation}`).bind(bytes, kind, ...identity(op))
      .first<{ matches: number }>();
    if (!row) return 'unknown';
    return row.matches === 1 ? 'recorded' : 'conflict';
  }
}
