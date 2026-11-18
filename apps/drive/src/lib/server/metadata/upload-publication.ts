import { createImmutableS3Reader, createS3Objects } from '../s3/objects';
import {
  decodeUploadIdentity, uploadIdentityBytes, uploadSessionHash, uploadStorageIdentity,
  type UploadEvidenceDatabase, type UploadPublicationVerifier,
} from './upload-completion-receipts';

interface Destination { entryId: string; parentId: string | null; name: string }

/** Unwired server-only publisher. Qualification must cover this exact signer and namespace. */
export function createAtomicUploadPublication(db: UploadEvidenceDatabase, epoch: string, config: Parameters<typeof createS3Objects>[0],
  transport: Parameters<typeof createS3Objects>[1], verifier?: Pick<UploadPublicationVerifier, 'isQualified'>) {
  const { settings, endpoint, bucket, storageConfigId } = uploadStorageIdentity(epoch, config);
  const reader = createImmutableS3Reader(createS3Objects(settings, { ...transport }));

  return {
    storageConfigId,
    async publish(token: string, operationId: string, destination: Destination): Promise<boolean> {
      const hash = verifier && await uploadSessionHash(token);
      if (!hash || !verifier) return false;
      const operation = uploadIdentityBytes(operationId);
      const entry = uploadIdentityBytes(destination.entryId);
      const parent = destination.parentId === null ? null : uploadIdentityBytes(destination.parentId);
      const name = uploadIdentityBytes(destination.name, 255);
      if (!await verifier.isQualified(storageConfigId)) return false;

      // Check on a fresh primary session, including when the acknowledgement
      // was lost. A different destination or a tombstoned map is not success.
      const committed = async () => (await db.withSession('first-primary').prepare(`SELECT p.entry_id FROM drive_upload_publications p
        JOIN drive_upload_publication_refs r USING (entry_id)
        JOIN drive_upload_completion_dispatches d ON d.operation_id = p.operation_id
        JOIN drive_active_members m ON m.id = p.owner_id
        JOIN drive_sessions auth ON auth.principal_id = p.owner_id AND auth.token_hash = d.session_hash
          AND auth.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        WHERE p.operation_id = CAST(? AS TEXT) AND r.storage_config_id = ? AND auth.token_hash = ?
          AND p.entry_id = CAST(? AS TEXT) AND p.parent_id IS CAST(? AS TEXT) AND p.name = CAST(? AS TEXT)`)
        .bind(operation, storageConfigId, hash, entry, parent, name).first()) !== null;
      if (await committed()) return true;

      const scope = [operation, hash, endpoint, bucket, epoch] as const;
      const eligible = `FROM drive_upload_publishable_receipts
        WHERE operation_id = CAST(? AS TEXT) AND session_hash = ? AND endpoint = ? AND bucket = ? AND storage_epoch = ?`;
      const receipt = await db.withSession('first-primary').prepare(`SELECT hex(object_key) AS key_hex, evidence_revision, etag, size_bytes ${eligible}`)
        .bind(...scope).first<{ key_hex: string; evidence_revision: string; etag: string; size_bytes: number }>();
      if (!receipt) return committed(); // An exact winner can commit between the two primary reads.
      try {
        const metadata = await reader.head({ key: decodeUploadIdentity(receipt.key_hex), etag: receipt.etag });
        if (metadata.status !== 200 || typeof metadata.contentLength !== 'string' ||
          !/^\d+$/.test(metadata.contentLength) || Number(metadata.contentLength) !== receipt.size_bytes) return false;
      } catch { return committed(); } // Only acknowledge an exact winner; never write after failed HEAD.

      try {
        const published = await db.prepare(`INSERT INTO drive_upload_publications
          (entry_id, owner_id, operation_id, evidence_revision, parent_id, name)
          SELECT CAST(? AS TEXT), owner_id, operation_id, evidence_revision, CAST(? AS TEXT), CAST(? AS TEXT)
          ${eligible} AND evidence_revision = ? RETURNING entry_id`)
          .bind(entry, parent, name, ...scope, receipt.evidence_revision).first();
        if (published) return true;
      } catch { /* A destination conflict rolls back both rows; reconcile an uncertain acknowledgement below. */ }
      return committed();
    },
  };
}
