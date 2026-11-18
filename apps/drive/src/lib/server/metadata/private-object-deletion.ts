import { decodeUploadIdentity } from './upload-storage-evidence';

interface Statement {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Session { prepare(sql: string): Statement }
interface Database { withSession(constraint: 'first-primary'): Session }

interface GenerationRow {
  endpoint: string;
  bucket: string;
  storage_epoch: string;
  key_hex: string;
  etag: string;
  size_bytes: number;
  evidence_revision: string;
}

interface DeleteTarget {
  key: string;
  etag: string;
  sizeBytes: number;
  evidenceRevision: string;
}

// Composition root only: resolve the exact qualified historical configuration.
// Qualification must establish exclusive mutation, non-versioned permanent
// deletion and atomic If-Match. No HEAD-then-delete or unconditional fallback.
export type ResolveObjectDeleter = (storageConfigId: string) => {
  storageConfigId: string;
  deleteIfMatch(target: Readonly<DeleteTarget>, signal: AbortSignal): Promise<'deleted' | 'unconfirmed'>;
} | null;

const batchLimit = 8;
const leaseSeconds = 60;
const retrySeconds = 300;
const requestMs = 5000;

async function remove(row: GenerationRow, resolve: ResolveObjectDeleter): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const key = decodeUploadIdentity(row.key_hex);
    const { endpoint, bucket, storage_epoch, etag, size_bytes, evidence_revision } = row;
    if (!key || key.includes('\0') || key.split('/').some(segment => segment === '.' || segment === '..') ||
        !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) return false;
    const storageConfigId = JSON.stringify([endpoint, bucket, storage_epoch]);
    const provider = resolve(storageConfigId);
    if (provider?.storageConfigId !== storageConfigId) return false;
    const deadline = new Promise<'unconfirmed'>((done) => {
      timer = setTimeout(() => { controller.abort(); done('unconfirmed'); }, requestMs);
    });
    const target = Object.freeze({ key, etag, sizeBytes: size_bytes, evidenceRevision: evidence_revision });
    const outcome = await Promise.race([provider.deleteIfMatch(target, controller.signal), deadline]);
    return !controller.signal.aborted && outcome === 'deleted';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Unwired server primitive. Absence, conflict and uncertainty never settle a job. */
export async function reconcilePrivateObjectDeletions(db: Database, resolve?: ResolveObjectDeleter): Promise<number> {
  if (!resolve) return 0;
  const session = db.withSession('first-primary');
  let completed = 0;
  for (let i = 0; i < batchLimit; i++) {
    const token = crypto.randomUUID();
    const claim = await session.prepare(`UPDATE drive_object_deletion_jobs
      SET lease_token = ?, available_at = unixepoch() + ?
      WHERE entry_id = (SELECT entry_id FROM drive_object_deletion_jobs
        WHERE completed_at IS NULL AND available_at <= unixepoch()
        ORDER BY available_at, entry_id LIMIT 1)
      RETURNING entry_id`).bind(token, leaseSeconds).first<{ entry_id: string }>();
    if (!claim) break;
    const row = await session.prepare(`SELECT g.endpoint, g.bucket, g.storage_epoch, hex(g.object_key) AS key_hex,
        g.etag, g.size_bytes, g.evidence_revision
      FROM drive_object_deletion_jobs j JOIN drive_deleted_entries t USING (entry_id)
      JOIN drive_published_generations g ON g.entry_id = t.entry_id AND g.owner_id = t.owner_id AND g.object_key = t.object_key
      JOIN drive_upload_publication_tombstones f USING (intent_id)
      WHERE j.entry_id = ? AND j.lease_token = ? AND j.available_at > unixepoch() AND j.completed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM drive_entries e WHERE e.id = j.entry_id OR e.object_key = g.object_key)`)
      .bind(claim.entry_id, token).first<GenerationRow>();
    const deleted = row !== null && await remove(row, resolve);
    // A provider request might outlive its Worker or lease. Only the current
    // lease can settle the job; a repeated request still targets the same generation.
    const settled = await session.prepare(`UPDATE drive_object_deletion_jobs
      SET lease_token = NULL, available_at = unixepoch() + ?, completed_at = CASE WHEN ? THEN unixepoch() ELSE NULL END
      WHERE entry_id = ? AND lease_token = ? AND available_at > unixepoch() AND completed_at IS NULL
      RETURNING completed_at`).bind(retrySeconds, Number(deleted), claim.entry_id, token).first<{ completed_at: number | null }>();
    if (settled?.completed_at != null) completed++;
  }
  return completed;
}
