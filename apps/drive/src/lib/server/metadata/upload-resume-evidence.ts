import type { UploadResumeEvidence } from '../../upload-resume-evidence';
import { tokenHash } from '../identity/sessions';
import { MAX_PART_BYTES } from '../s3/multipart-completion';
import { uploadIdPattern } from '../upload-part';

interface Statement {
  bind(...values: string[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { withSession(constraint: 'first-primary'): { prepare(sql: string): Statement } }
interface EvidenceRow {
  declaredSize: number;
  partNumber: number | null;
  sizeBytes: number | null;
  sha256: string | null;
}

// This projection is for the sequential picker, whose multipart limit is 5 GiB.
const maxBytes = 5 * 1024 ** 3;
const maxParts = maxBytes / MAX_PART_BYTES;
const sha256Pattern = /^[0-9a-f]{64}$/;

// Start with every operation, not just reusable ones. A proofless or stale
// operation must remain visible as an invalid row, never as a missing slot.
const projection = `SELECT i.declared_size AS declaredSize, o.part_number AS partNumber, o.size_bytes AS sizeBytes,
    CASE WHEN r.reported_etag = e.reported_etag AND EXISTS (
      SELECT 1 FROM drive_upload_resumable_part_operations live WHERE live.operation_id = o.operation_id
    ) THEN lower(hex(e.sha256)) END AS sha256
  FROM drive_upload_intents i
  JOIN drive_upload_storage_bindings b ON b.intent_id = i.id
  JOIN drive_sessions s ON s.principal_id = i.owner_id
  JOIN drive_active_members m ON m.id = i.owner_id
  JOIN drive_login_generations g ON g.principal_id = i.owner_id
  LEFT JOIN drive_upload_part_operations o ON o.intent_id = i.id
  LEFT JOIN drive_upload_part_byte_evidence e ON e.operation_id = o.operation_id
  LEFT JOIN drive_upload_part_observations r ON r.operation_id = o.operation_id AND r.kind = 'reported'
  WHERE i.id = ? AND i.owner_id = ? AND s.token_hash = ? AND g.generation = ?
    AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND b.endpoint = ? AND b.bucket = ? AND b.storage_epoch = ?
    AND i.state = 'allocated' AND i.completion_acknowledged = 0 AND i.upload_id IS NOT NULL
    AND i.version < 9007199254740990 AND i.declared_size BETWEEN 0 AND ${maxBytes}
    AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_operations WHERE intent_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones WHERE intent_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_attempts WHERE intent_id = i.id)
  ORDER BY o.part_number LIMIT ${maxParts + 1}`;

// Identity/generation and normalized storage binding are trusted server inputs,
// not browser assertions. The projection is evidence, not upload admission.
export async function readUploadResumeEvidence(db: Database, intentId: string,
  { token, principalId, generation }: { token: string; principalId: string; generation: string },
  { endpoint, bucket, storageEpoch }: { endpoint: string; bucket: string; storageEpoch: string }
): Promise<UploadResumeEvidence | null> {
  if (!uploadIdPattern.test(intentId) || !/^[A-Za-z0-9_-]{43}$/.test(token) || !sha256Pattern.test(generation)) return null;
  try {
    const hash = await tokenHash(token);
    const { results } = await db.withSession('first-primary').prepare(projection)
      .bind(intentId, principalId, hash, generation, endpoint, bucket, storageEpoch).all<EvidenceRow>();
    const row = results[0];
    if (!row) return null;
    const { declaredSize } = row;
    const parts: UploadResumeEvidence['parts'][number][] = [];
    if (row.partNumber === null) return { declaredSize, parts }; // No operation rows.
    const partCount = Math.max(1, Math.ceil(declaredSize / MAX_PART_BYTES));
    if (results.length > partCount) return null;
    for (const [offset, { partNumber, sizeBytes, sha256 }] of results.entries()) {
      const expectedSize = Math.min(MAX_PART_BYTES, declaredSize - offset * MAX_PART_BYTES);
      if (partNumber !== offset + 1 || sizeBytes !== expectedSize || sha256 === null || !sha256Pattern.test(sha256)) return null;
      parts.push({ partNumber, sizeBytes, sha256 });
    }
    return { declaredSize, parts };
  } catch {
    return null;
  }
}
