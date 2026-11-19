import { Sessions } from '../identity/sessions';
import { createMultipartComplete } from '../s3/multipart-complete';
import { completionXml, type CompletedPart } from '../s3/multipart-completion';
import { requireActiveOwner } from './private';
import { decodeUploadIdentity, uploadIdentityBytes, uploadStorageEvidence } from './upload-storage-evidence';

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
// the signer's exact namespace and exclusive writers; a namespace change requires
// a different epoch even if the endpoint and bucket are unchanged. The verifier
// must establish acknowledged ETags and actual byte counts independently of D1.
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
    beforeSend?: () => Promise<boolean>;
  }>): Promise<readonly CompletedPart[] | null>;
}

type UploadOwner = 'i.owner_id' | 'o.owner_id' | 'c.owner_id';
export const accessibleUploadParent = (owner: UploadOwner) =>
  `(? IS NULL OR EXISTS (SELECT 1 FROM drive_entries p WHERE p.id = ? AND p.owner_id = ${owner} AND p.kind = 'folder'))`;
export const occupiedUploadName = (owner: UploadOwner) =>
  `EXISTS (SELECT 1 FROM drive_entries s WHERE s.owner_id = ${owner}
    AND COALESCE(s.parent_id, '') = COALESCE(?, '') AND s.name = ?)`;
export const availableUploadDestination = (owner: UploadOwner) =>
  `${accessibleUploadParent(owner)} AND NOT ${occupiedUploadName(owner)}`;

const utf8 = new TextEncoder();
const sealed = `FROM drive_upload_sealed_candidates o
  WHERE o.operation_id = CAST(? AS TEXT) AND o.storage_epoch = ? AND o.endpoint = ? AND o.bucket = ? AND o.session_hash = ?
    AND NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims c WHERE c.intent_id = o.intent_id)
    AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_attempts a WHERE a.intent_id = o.intent_id)`;

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Reported bytes are HTTP opaque bytes, not decoded UTF-8 or parsed digests.
function tagHex(etag: string): string {
  return Array.from(etag, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
}

async function matchesSealedParts(db: Session, operation: ArrayBuffer, upload: SealedUpload, parts: readonly CompletedPart[]): Promise<boolean> {
  if (JSON.stringify(parts.map((part) => part.partNumber)) !== upload.part_numbers ||
    parts.reduce((total, part) => total + part.size, 0) !== upload.size_bytes) return false;

  // SQLite BLOBs need a byte-exact comparison. Page before converting to hex
  // so the 10,000-slot limit does not imply an unbounded D1 result body.
  for (let offset = 0; offset < parts.length; offset += 64) {
    const { results } = await db.prepare(`SELECT p.part_number, p.size_bytes, hex(r.reported_etag) AS etag
      FROM drive_upload_completion_operations o JOIN drive_upload_part_operations p ON p.intent_id = o.intent_id
      JOIN drive_upload_part_observations r ON r.operation_id = p.operation_id AND r.kind = 'reported'
      WHERE o.operation_id = CAST(? AS TEXT) AND p.part_number > ? ORDER BY p.part_number LIMIT 64`)
      .bind(operation, parts[offset - 1]?.partNumber ?? 0)
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
  transport: Parameters<typeof createMultipartComplete>[1], verifier?: UploadPublicationVerifier, ownerOnly = false) {
  const allocated = `${sealed} ${requireActiveOwner(ownerOnly, 'o.owner_id')}`;
  const { settings, storageConfigId } = uploadStorageEvidence(config, epoch);
  const { endpoint, bucket } = settings;
  const { streamBudget, ...options } = transport;
  const transportOptions = { ...options, streamBudget: streamBudget && { ...streamBudget } };

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
      try {
        const current = await db.withSession('first-primary').prepare(`SELECT evidence_revision, etag, response_checksums
          FROM drive_upload_completion_receipts WHERE operation_id = CAST(? AS TEXT)`).bind(operation).first<Receipt>();
        if (current) return current.evidence_revision === evidence_revision && current.etag === etag &&
          current.response_checksums === response_checksums;
      } catch { /* Only the same immutable receipt insert may be retried. */ }
    }
    return false;
  }

  return {
    storageConfigId,
    async complete(token: string, operationId: string, target?: { parentId: string | null; name: string }):
      Promise<'recorded' | 'not-admitted' | 'dispatch-denied' | 'uncertain'> {
      if (!verifier || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return 'not-admitted';
      const operation = uploadIdentityBytes(operationId);
      const admission = [operation, epoch, endpoint, bucket, await digest(utf8.encode(token))] as const;
      const primary = db.withSession('first-primary');
      const upload = await primary.prepare(`SELECT hex(o.intent_id) AS intent_id, hex(o.owner_id) AS owner_id,
        hex(o.object_key) AS object_key, hex(o.upload_id) AS upload_id, o.intent_version, o.part_numbers, o.size_bytes
        ${allocated}`).bind(...admission).first<SealedUpload>();
      if (!upload) return 'not-admitted';
      let intentId: string, ownerId: string, objectKey: string, uploadId: string;
      try {
        [intentId, ownerId, objectKey, uploadId] = [upload.intent_id, upload.owner_id, upload.object_key, upload.upload_id].map(decodeUploadIdentity);
      } catch { return 'not-admitted'; }
      if ([intentId, ownerId, objectKey, uploadId].some((value) => !value || value.includes('\0')) ||
        objectKey.split('/').some((segment) => segment === '.' || segment === '..') ||
        await verifier.isQualified(storageConfigId) !== true) return 'not-admitted';
      const checkOwner = ownerOnly ? () => new Sessions(db.withSession('first-primary')).isLiveOwner(token, ownerId) : undefined;
      const verified = await verifier.verifyParts(Object.freeze({ storageConfigId, operationId, intentId, ownerId,
        objectKey, uploadId, intentVersion: upload.intent_version, ...(checkOwner && { beforeSend: checkOwner }) }));
      if (!verified || !Array.isArray(verified) || verified.length < 1 || verified.length > 10000) return 'not-admitted';
      const parts = verified.map(({ partNumber, etag, size }) => ({ partNumber, etag, size }));
      let manifest: Uint8Array<ArrayBuffer>;
      try { manifest = new Uint8Array(completionXml(parts)); } catch { return 'not-admitted'; }
      if (!await matchesSealedParts(primary, operation, upload, parts)) return 'not-admitted';
      const manifestDigest = await digest(manifest);
      if (await verifier.isQualified(storageConfigId) !== true) return 'not-admitted';
      const complete = createMultipartComplete(settings, { ...transportOptions,
        beforeSend: async () => await verifier.isQualified(storageConfigId) === true &&
          (!checkOwner || await checkOwner()) });

      // Only an acknowledged insert can dispatch, even if a later read finds the claim.
      try {
        const destination = target ? [target.parentId, target.parentId, target.parentId, target.name] : [];
        const claim = await db.prepare(`INSERT INTO drive_upload_completion_dispatches
          (operation_id, endpoint, bucket, claim_version, manifest_digest, session_hash)
          SELECT o.operation_id, o.endpoint, o.bucket, o.intent_version + 1, ?, o.session_hash ${allocated}
          ${target ? `AND ${availableUploadDestination('o.owner_id')}` : ''} RETURNING operation_id`)
          .bind(manifestDigest, ...admission, ...destination).first();
        if (!claim) return target ? 'dispatch-denied' : 'not-admitted';
      } catch { return 'uncertain'; } // A durable claim without a receipt is already fenced.

      try {
        const response = await complete(objectKey, uploadId, parts);
        const receipt = { etag: response.etag, response_checksums: JSON.stringify(response.checksums ?? {}),
          evidence_revision: crypto.randomUUID() };
        if (await persistReceipt(operation, receipt)) return 'recorded';
      } catch { /* Neither a failed response nor a lost write permits redispatch. */ }
      try { await quarantine(operation); } catch { /* no receipt remains non-publishable */ }
      return 'uncertain';
    },

    // Trusted recovery only; there is no request path to this historical fence.
    async quarantineUnresolved(operationId: string): Promise<void> {
      await quarantine(uploadIdentityBytes(operationId));
    }
  };
}
