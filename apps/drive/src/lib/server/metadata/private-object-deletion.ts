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
  lease_remaining_ms: number;
}

interface DeleteTarget {
  key: string;
  etag: string;
  sizeBytes: number;
  evidenceRevision: string;
}

// Composition root only: resolve the exact qualified historical configuration.
// Qualification must establish exclusive mutation, non-versioned permanent
// deletion and atomic If-Match. Only a reply that distinguishes removal from
// an already-absent object may count as deleted. No HEAD-then-delete fallback.
// The adapter must honor the signal at the provider dispatch boundary.
export type ResolveObjectDeleter = (storageConfigId: string) => {
  storageConfigId: string;
  deleteIfMatch(target: Readonly<DeleteTarget>, signal: AbortSignal): Promise<'deleted' | 'unconfirmed'>;
} | null;

const batchLimit = 8;
const leaseSeconds = 60;
const retrySeconds = 300;
const requestMs = 5000;

async function remove(row: GenerationRow, resolve: ResolveObjectDeleter, leaseDeadline: number,
  readLease: () => Promise<{ remaining_ms: number } | null>): Promise<boolean> {
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
    const target = Object.freeze({ key, etag, sizeBytes: size_bytes, evidenceRevision: evidence_revision });
    const checkStarted = performance.now();
    if (checkStarted + requestMs >= leaseDeadline) return false;
    // Workers clocks may not advance during synchronous resolver work.
    const freshLease = await readLease();
    const requestDeadline = performance.now() + requestMs;
    if (!freshLease || requestDeadline >= Math.min(leaseDeadline, checkStarted + freshLease.remaining_ms)) return false;
    const deadline = new Promise<'unconfirmed'>((done) => {
      timer = setTimeout(() => { controller.abort(); done('unconfirmed'); }, requestMs);
    });
    const outcome = await Promise.race([provider.deleteIfMatch(target, controller.signal), deadline]);
    return !controller.signal.aborted && performance.now() < requestDeadline && outcome === 'deleted';
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
    const readStarted = performance.now();
    const row = await session.prepare(`SELECT g.endpoint, g.bucket, g.storage_epoch, hex(g.object_key) AS key_hex,
        g.etag, g.size_bytes, g.evidence_revision, 1000 * (j.available_at - unixepoch('subsec')) AS lease_remaining_ms
      FROM drive_object_deletion_jobs j JOIN drive_deleted_entries t USING (entry_id)
      JOIN drive_published_generations g ON g.entry_id = t.entry_id AND g.owner_id = t.owner_id AND g.object_key = t.object_key
      JOIN drive_upload_publication_tombstones f USING (intent_id)
      WHERE j.entry_id = ? AND j.lease_token = ? AND j.available_at > unixepoch() AND j.completed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM drive_entries e WHERE e.id = j.entry_id OR e.object_key = g.object_key)`)
      .bind(claim.entry_id, token).first<GenerationRow>();
    // Charge the whole D1 round trip against the lease without comparing the
    // Worker's wall clock with D1's. A stale read must not start a provider call.
    const leaseDeadline = readStarted + (row?.lease_remaining_ms ?? 0);
    const readLease = () => db.withSession('first-primary').prepare(`SELECT 1000 * (available_at - unixepoch('subsec')) AS remaining_ms
      FROM drive_object_deletion_jobs
      WHERE entry_id = ? AND lease_token = ? AND available_at > unixepoch() AND completed_at IS NULL`)
      .bind(claim.entry_id, token).first<{ remaining_ms: number }>();
    const deleted = row !== null && await remove(row, resolve, leaseDeadline, readLease);
    // Only the current lease can settle, even if an issued request outlives it.
    const settle = () => session.prepare(`UPDATE drive_object_deletion_jobs
      SET lease_token = NULL, available_at = unixepoch() + ?, completed_at = CASE WHEN ? THEN unixepoch() ELSE NULL END,
        completion_token = CASE WHEN ? THEN lease_token ELSE NULL END
      WHERE entry_id = ? AND lease_token = ? AND available_at > unixepoch() AND completed_at IS NULL
      RETURNING completed_at`).bind(retrySeconds, Number(deleted), Number(deleted), claim.entry_id, token).first<{ completed_at: number | null }>();
    const settled = await settle().catch(async error => {
      if (!deleted) throw error;
      // Retry only the fenced write, then look for this lease's receipt if
      // the first write may have committed without a reply.
      const retried = performance.now() < leaseDeadline ? await settle() : null;
      return retried ?? db.withSession('first-primary').prepare(`SELECT completed_at
        FROM drive_object_deletion_jobs WHERE entry_id = ? AND completion_token = ?`)
        .bind(claim.entry_id, token).first<{ completed_at: number }>();
    });
    if (settled?.completed_at != null) completed++;
  }
  return completed;
}
