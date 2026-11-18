import { validateConfig } from '../s3/config';
import { createMultipartComplete } from '../s3/multipart-complete';
import { completionXml, type CompletedPart } from '../s3/multipart-completion';

interface Statement {
  bind(...values: (string | number | null | ArrayBuffer)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Session { prepare(sql: string): Statement }
interface Database extends Session { withSession(constraint: 'first-primary'): Session }

interface SealedUpload {
  intent_id: string;
  owner_id: string;
  object_key: string;
  upload_id: string;
  intent_version: number;
  part_numbers: string;
  size_bytes: number;
}
interface Receipt { evidence_revision: string; etag: string; response_checksums: string }

// A composition-root dependency, not request input. Qualification must cover
// this exact immutable namespace and exclusive writers. The part verifier must
// independently establish acknowledged ETags and actual byte counts for this
// admitted upload; sealed observation rows alone do not establish either.
interface UploadPublicationVerifier {
  isQualified(storageConfigId: string): Promise<boolean>;
  verifyParts(upload: Readonly<{
    storageConfigId: string;
    operationId: string;
    intentId: string;
    ownerId: string;
    objectKey: string;
    uploadId: string;
    intentVersion: number;
  }>): Promise<readonly CompletedPart[] | null>;
}

const utf8 = new TextEncoder();
const liveSession = `auth.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)`;
const allocated = `FROM drive_upload_sealed_candidates o
  JOIN drive_upload_intents i ON i.id = o.intent_id AND i.owner_id = o.owner_id AND i.object_key = o.object_key
  JOIN drive_active_members m ON m.id = i.owner_id
  JOIN drive_sessions auth ON auth.principal_id = i.owner_id AND ${liveSession}
  WHERE o.operation_id = CAST(? AS TEXT) AND o.storage_epoch = ? AND auth.token_hash = ?
    AND i.state = 'allocated' AND i.completion_acknowledged = 0 AND i.version = o.intent_version
    AND i.upload_id = o.upload_id
    AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_dispatches d WHERE d.operation_id = o.operation_id)`;

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sessionHash(token: string): Promise<string | null> {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(utf8.encode(token)) : null;
}

function boundedText(value: string, limit = 196608): ArrayBuffer {
  if (typeof value !== 'string' || value.length < 1 || value.length > limit || /[\uD800-\uDFFF\0]/u.test(value)) {
    throw new TypeError('Invalid upload publication identity');
  }
  const bytes = utf8.encode(value);
  if (bytes.byteLength > limit) throw new TypeError('Invalid upload publication identity');
  return bytes.buffer;
}

// Reported bytes are HTTP opaque bytes, not decoded UTF-8 or parsed digests.
function tagHex(etag: string): string {
  return Array.from(etag, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function matchesSealedParts(db: Session, upload: SealedUpload, parts: readonly CompletedPart[]): Promise<boolean> {
  if (JSON.stringify(parts.map((part) => part.partNumber)) !== upload.part_numbers ||
    parts.reduce((total, part) => total + part.size, 0) !== upload.size_bytes) return false;

  // SQLite BLOBs need a byte-exact comparison. Page before converting to hex
  // so the 10,000-slot limit does not imply an unbounded D1 result body.
  for (let offset = 0; offset < parts.length; offset += 64) {
    const { results } = await db.prepare(`SELECT p.part_number, p.size_bytes, hex(r.reported_etag) AS etag
      FROM drive_upload_part_operations p JOIN drive_upload_part_observations r USING (operation_id)
      WHERE p.intent_id = CAST(? AS TEXT) AND p.part_number > ? AND r.kind = 'reported'
      ORDER BY p.part_number LIMIT 64`)
      .bind(boundedText(upload.intent_id), parts[offset - 1]?.partNumber ?? 0)
      .all<{ part_number: number; size_bytes: number; etag: string }>();
    if (results.length !== Math.min(64, parts.length - offset) || results.some((row, index) => {
      const part = parts[offset + index];
      return row.part_number !== part.partNumber || row.size_bytes !== part.size || row.etag !== tagHex(part.etag);
    })) return false;
  }
  return true;
}

/** Unwired server-only producer; there is no default qualified verifier. */
export function createUploadCompletionReceipts(db: Database, epoch: string, config: Parameters<typeof createMultipartComplete>[0],
  transport: Parameters<typeof createMultipartComplete>[1], verifier?: UploadPublicationVerifier) {
  if (typeof epoch !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(epoch)) throw new TypeError('Invalid storage epoch');
  const settings = validateConfig(config);
  const { endpoint, bucket } = settings;
  if (endpoint.length > 2048) throw new TypeError('Invalid storage identity');
  const storageConfigId = JSON.stringify([endpoint, bucket, epoch]);
  const complete = createMultipartComplete(settings, transport);

  async function quarantine(operation: ArrayBuffer): Promise<void> {
    await db.prepare(`INSERT INTO drive_upload_completion_quarantine (operation_id)
      SELECT d.operation_id FROM drive_upload_completion_dispatches d
      JOIN drive_upload_completion_operations o USING (operation_id)
      WHERE d.operation_id = CAST(? AS TEXT) AND d.endpoint = ? AND d.bucket = ? AND o.storage_epoch = ?
        AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_receipts r WHERE r.operation_id = d.operation_id)
        AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_quarantine q WHERE q.operation_id = d.operation_id)
      RETURNING operation_id`).bind(operation, endpoint, bucket, epoch).first();
  }

  async function persistReceipt(operation: ArrayBuffer, receipt: Receipt): Promise<boolean> {
    const { evidence_revision, etag, response_checksums } = receipt;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const written = await db.prepare(`INSERT INTO drive_upload_completion_receipts
          (operation_id, evidence_revision, etag, response_checksums) VALUES (CAST(? AS TEXT), ?, ?, ?) RETURNING operation_id`)
          .bind(operation, evidence_revision, etag, response_checksums).first();
        if (written) return true;
      } catch { /* Reconcile a potentially committed write before retrying it. */ }
      const current = await db.withSession('first-primary').prepare(`SELECT evidence_revision, etag, response_checksums
        FROM drive_upload_completion_receipts WHERE operation_id = CAST(? AS TEXT)`).bind(operation).first<Receipt>();
      if (current) return current.evidence_revision === evidence_revision && current.etag === etag &&
        current.response_checksums === response_checksums;
    }
    return false;
  }

  return {
    storageConfigId,
    async complete(token: string, operationId: string): Promise<'recorded' | 'not-admitted' | 'uncertain'> {
      const hash = await sessionHash(token);
      if (!hash || !verifier) return 'not-admitted';
      const operation = boundedText(operationId);
      const primary = db.withSession('first-primary');
      const upload = await primary.prepare(`SELECT o.intent_id, o.owner_id, o.object_key, o.upload_id,
        o.intent_version, o.part_numbers, o.size_bytes ${allocated}`).bind(operation, epoch, hash).first<SealedUpload>();
      if (!upload || !await verifier.isQualified(storageConfigId)) return 'not-admitted';
      const key = boundedText(upload.object_key);
      const uploadId = boundedText(upload.upload_id);
      const verified = await verifier.verifyParts(Object.freeze({ storageConfigId, operationId, intentId: upload.intent_id,
        ownerId: upload.owner_id, objectKey: upload.object_key,
        uploadId: upload.upload_id, intentVersion: upload.intent_version }));
      if (!verified || !Array.isArray(verified) || verified.length < 1 || verified.length > 10000) return 'not-admitted';
      const parts = verified.map(({ partNumber, etag, size }) => ({ partNumber, etag, size }));
      const manifestDigest = await digest(new Uint8Array(completionXml(parts)));
      if (!await matchesSealedParts(primary, upload, parts)) return 'not-admitted';

      // Only the acknowledged first insert authorizes dispatch. A primary read
      // of a committed claim never hands a restarted worker a dispatch permit.
      try {
        const claim = await db.prepare(`INSERT INTO drive_upload_completion_dispatches
          (operation_id, endpoint, bucket, claim_version, manifest_digest, session_hash)
          SELECT o.operation_id, ?, ?, o.intent_version + 1, ?, auth.token_hash ${allocated}
            AND CAST(o.object_key AS BLOB) = ? AND CAST(o.upload_id AS BLOB) = ?
            AND o.intent_version < 9007199254740990 RETURNING operation_id`)
          .bind(endpoint, bucket, manifestDigest, operation, epoch, hash, key, uploadId).first();
        if (!claim) return 'not-admitted';
      } catch { return 'uncertain'; }

      try {
        const response = await complete(upload.object_key, upload.upload_id, parts);
        const receipt = { etag: response.etag, response_checksums: JSON.stringify(response.checksums ?? {}),
          evidence_revision: crypto.randomUUID() };
        if (await persistReceipt(operation, receipt)) return 'recorded';
      } catch { /* Neither a failed response nor a lost write permits redispatch. */ }
      try { await quarantine(operation); } catch { /* no receipt remains non-publishable */ }
      return 'uncertain';
    },

    // Trusted recovery only; there is no request path to this historical fence.
    async quarantineUnresolved(operationId: string): Promise<void> {
      await quarantine(boundedText(operationId));
    }
  };
}
