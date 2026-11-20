import { Sessions, tokenHash } from '../identity/sessions';
import { createImmutableS3Reader, createS3Objects } from '../s3/objects';
import { requireActiveOwner, validateName } from './private';
import { decodeUploadIdentity, uploadIdentityBytes, uploadStorageEvidence } from './upload-storage-evidence';

interface Statement {
  bind(...values: (string | number | null | ArrayBuffer)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Session { prepare(sql: string): Statement }
interface Database extends Session { withSession(constraint: 'first-primary'): Session }
interface Receipt { key_hex: string; etag: string; size_bytes: number; evidence_revision: string }

export class UploadPublicationWriteError extends Error {
  constructor(cause: unknown) { super('Upload publication write failed', { cause }); }
}

const publishable = `FROM drive_upload_publishable_completions e
  WHERE e.operation_id = CAST(? AS TEXT) AND e.intent_id = CAST(? AS TEXT) AND e.owner_id = CAST(? AS TEXT)
    AND e.claim_version = ? AND e.endpoint = ? AND e.bucket = ? AND e.storage_epoch = ? AND e.session_hash = ?`;

// Unwired server-only publisher. A trusted composition root must explicitly
// qualify the exact namespace for conditional writes/reads and exclusive mutation.
// No environmental or provider-name heuristic substitutes for that evidence.
export function createTrustedUploadPublication(db: Database, epoch: string, config: Parameters<typeof createS3Objects>[0],
  transport: Parameters<typeof createS3Objects>[1], isQualified?: (storageConfigId: string) => Promise<boolean>, ownerOnly = false) {
  const candidate = `${publishable} ${requireActiveOwner(ownerOnly, 'e.owner_id')}`;
  const { settings, storageConfigId } = uploadStorageEvidence(config, epoch);
  const { endpoint, bucket } = settings;
  const { beforeSend, streamBudget, ...options } = transport;
  const budget = streamBudget && { idleMs: streamBudget.idleMs, totalMs: streamBudget.totalMs };
  const makeReader = (checkOwner?: () => Promise<boolean>) => createImmutableS3Reader(createS3Objects(settings, { ...options,
    streamBudget: budget, beforeSend: async () => (!beforeSend || await beforeSend() === true) &&
      await isQualified?.(storageConfigId) === true && (!checkOwner || await checkOwner()) }));
  const reader = makeReader(); // Validate the transport even when each request needs its own owner check.
  return {
    async publish(token: string, principalId: string, intentId: string, claimVersion: number,
      operationId: string, parentId: string | null, name: string): Promise<{ id: string } | null> {
      if (!isQualified || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      validateName(name);
      if (!Number.isSafeInteger(claimVersion) || claimVersion < 1 || claimVersion >= Number.MAX_SAFE_INTEGER) {
        throw new TypeError('Invalid upload claim version');
      }
      const binding = [uploadIdentityBytes(operationId), uploadIdentityBytes(intentId), uploadIdentityBytes(principalId),
        claimVersion, endpoint, bucket, epoch, await tokenHash(token)] as const;
      const receipt = await db.withSession('first-primary').prepare(`SELECT hex(e.object_key) AS key_hex,
        e.etag, e.size_bytes, e.evidence_revision ${candidate}`).bind(...binding).first<Receipt>();
      if (!receipt) return null;

      const { key_hex, etag, size_bytes, evidence_revision } = receipt;
      try {
        const key = decodeUploadIdentity(key_hex);
        if (key.includes('\0')) return null;
        const current = ownerOnly
          ? makeReader(() => new Sessions(db.withSession('first-primary')).isLiveOwner(token, principalId)) : reader;
        const head = await current.head({ key, etag });
        if (head.status !== 200 || typeof head.contentLength !== 'string' || !/^\d+$/.test(head.contentLength) ||
            Number(head.contentLength) !== size_bytes || await isQualified(storageConfigId) !== true) return null;
      } catch { return null; }

      // Use an INSERT SELECT, not a separate application check: authorization,
      // journal state and quarantine may have changed even during a matching HEAD.
      try {
        return await db.prepare(`INSERT INTO drive_upload_publications
          (intent_id, intent_version, entry_id, owner_id, object_key, parent_id, name, size_bytes, object_etag,
            completion_operation_id, evidence_revision)
          SELECT e.intent_id, e.claim_version, ?, e.owner_id, e.object_key, ?, ?, e.size_bytes, e.etag,
            e.operation_id, e.evidence_revision ${candidate}
            AND e.evidence_revision = ? AND e.etag = ? AND e.size_bytes = ?
          RETURNING entry_id AS id`)
          .bind(crypto.randomUUID(), parentId, name, ...binding, evidence_revision, etag, size_bytes).first<{ id: string }>();
      } catch (error) { throw new UploadPublicationWriteError(error); }
    }
  };
}
