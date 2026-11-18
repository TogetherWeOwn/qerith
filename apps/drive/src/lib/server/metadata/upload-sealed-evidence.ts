import type { CompletedPart } from '../s3/multipart-completion';
import { sealUploadManifest } from './upload-manifest';
import type { UploadCompletionOperation } from './upload-operation-evidence';

interface Statement {
  bind(...values: (string | number | ArrayBuffer)[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Session { prepare(sql: string): Statement }
interface Database extends Session { withSession(constraint: 'first-primary'): Session }

type ObservedPart = CompletedPart & { operationId: string };
interface Snapshot {
  operation: UploadCompletionOperation;
  parts: readonly ObservedPart[];
  sizeBytes: number;
}
type Reconciliation = 'recorded' | 'conflict' | 'unknown';

const utf8 = new TextEncoder();
const token = (value: unknown): value is string => typeof value === 'string' && value.length >= 1
  && value.length <= 128 && !/[^A-Za-z0-9._:-]/.test(value);
function text(value: string): ArrayBuffer {
  // Match SQLite TEXT by exact UTF-8 bytes, without replacing lone surrogates.
  if (typeof value !== 'string' || value.length < 1 || value.length > 65536 || /[\uD800-\uDFFF]/u.test(value)) {
    throw new TypeError('Invalid sealed upload identity');
  }
  return utf8.encode(value).buffer;
}
function identity(op: UploadCompletionOperation): (string | number | ArrayBuffer)[] {
  const { operationId, intentId, ownerId, objectKey, storageEpoch, uploadId, intentVersion } = op;
  if (!token(operationId) || !token(storageEpoch) || !Number.isSafeInteger(intentVersion) || intentVersion < 0) {
    throw new TypeError('Invalid sealed upload identity');
  }
  return [operationId, text(intentId), text(ownerId), text(objectKey), storageEpoch, text(uploadId), intentVersion];
}
const exactOperation = `o.operation_id = ? AND o.intent_id = CAST(? AS TEXT) AND o.owner_id = CAST(? AS TEXT)
  AND o.object_key = CAST(? AS TEXT) AND o.storage_epoch = ? AND o.upload_id = CAST(? AS TEXT) AND o.intent_version = ?`;
const fromSnapshot = `FROM drive_upload_completion_operations o JOIN drive_upload_sealed_snapshots s USING (operation_id)`;
const exactSnapshot = 's.manifest = ? AND s.size_bytes = ?';

function manifest(parts: readonly ObservedPart[], size: number): string {
  if (!Array.isArray(parts) || parts.length > 10_000) throw new TypeError('Invalid sealed upload parts');
  let remaining = 256 * 1024;
  const snapshot = Array.from(parts, ({ operationId, partNumber, etag, size }) => {
    if (!token(operationId) || typeof etag !== 'string' || etag.length > 8192) throw new TypeError('Invalid sealed upload part');
    remaining -= etag.length;
    if (remaining < 0) throw new TypeError('Sealed upload snapshot exceeds limit');
    return { operationId, partNumber, etag, size };
  });
  sealUploadManifest(snapshot, size);
  const json = JSON.stringify(snapshot);
  if (utf8.encode(json).byteLength > 256 * 1024) throw new TypeError('Sealed upload snapshot exceeds limit');
  return json;
}

const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)!.get!;
function reportBuffer(bytes: Uint8Array): ArrayBuffer {
  if (typedArrayTag.call(bytes) !== 'Uint8Array') throw new TypeError('Invalid sealed upload report');
  const size: number = Reflect.get(Uint8Array.prototype, 'byteLength', bytes);
  if (size < 1 || size > 65536) throw new TypeError('Invalid sealed upload report');
  return new Uint8Array(bytes).buffer;
}

// Unwired server-only storage. Sealing fixes a historical set of observations;
// it does not settle provider writes, create a receipt or grant live authority.
export class UploadSealedEvidence {
  constructor(private readonly db: Database) {}

  async recordSnapshot({ operation, parts, sizeBytes }: Snapshot): Promise<void> {
    const row = await this.db.prepare(`INSERT INTO drive_upload_sealed_snapshots (operation_id, manifest, size_bytes)
      SELECT o.operation_id, ?, ? FROM drive_upload_completion_operations o WHERE ${exactOperation}
      RETURNING operation_id`).bind(manifest(parts, sizeBytes), sizeBytes, ...identity(operation)).first();
    if (!row) throw new Error('No matching upload completion operation');
  }

  async recordUnverifiedReport({ operation, parts, sizeBytes }: Snapshot, report: Uint8Array): Promise<void> {
    const row = await this.db.prepare(`INSERT INTO drive_upload_sealed_reports (operation_id, report_bytes)
      SELECT o.operation_id, ? ${fromSnapshot} WHERE ${exactOperation} AND ${exactSnapshot} RETURNING operation_id`)
      .bind(reportBuffer(report), ...identity(operation), manifest(parts, sizeBytes), sizeBytes).first();
    if (!row) throw new Error('No matching sealed upload snapshot');
  }

  // An exact primary read only answers whether the original D1 write committed.
  // Absence or an unavailable primary cannot justify a provider retry.
  async reconcileSnapshotWrite({ operation, parts, sizeBytes }: Snapshot): Promise<Reconciliation> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT (${exactSnapshot}) AS matches
      ${fromSnapshot} WHERE ${exactOperation}`).bind(manifest(parts, sizeBytes), sizeBytes, ...identity(operation))
      .first<{ matches: number }>();
    return !row ? 'unknown' : row.matches === 1 ? 'recorded' : 'conflict';
  }

  async reconcileReportWrite({ operation, parts, sizeBytes }: Snapshot, report: Uint8Array): Promise<Reconciliation> {
    const row = await this.db.withSession('first-primary').prepare(`SELECT (r.report_bytes = ?) AS matches
      ${fromSnapshot} JOIN drive_upload_sealed_reports r USING (operation_id)
      WHERE ${exactOperation} AND ${exactSnapshot}`).bind(reportBuffer(report), ...identity(operation),
      manifest(parts, sizeBytes), sizeBytes).first<{ matches: number }>();
    return !row ? 'unknown' : row.matches === 1 ? 'recorded' : 'conflict';
  }
}
