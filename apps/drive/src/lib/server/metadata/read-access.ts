import type { S3Config } from '../s3/config';
import type { ImmutableS3Reference } from '../s3/objects';
import { validateName } from './private';
import { decodeUploadIdentity, uploadStorageEvidence } from './upload-storage-evidence';

interface Statement {
  bind(...values: (string | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

export interface ReadEntry { id: string; name: string; kind: 'file' | 'folder' }
export interface ReadCursor { name: string; id: string }
export interface ReadPage { entries: ReadEntry[]; nextCursor: ReadCursor | null }

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
async function sessionHash(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Anchor at the requested entry, not at a previously authorized ancestor. Each
// statement rechecks both parties and the session against the current tree.
const access = `WITH RECURSIVE ancestors(id, parent_id, owner_id) AS (
  SELECT id, parent_id, owner_id FROM drive_entries WHERE id = ?
  UNION
  SELECT e.id, e.parent_id, e.owner_id FROM drive_entries e
    JOIN ancestors a ON e.id = a.parent_id AND e.owner_id = a.owner_id
), permitted AS (
  SELECT target.id FROM drive_entries target
  JOIN drive_principals owner ON owner.id = target.owner_id AND owner.status = 'active'
  JOIN drive_sessions s ON s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  JOIN drive_principals reader ON reader.id = s.principal_id AND reader.status = 'active'
  WHERE target.id = ? AND (target.owner_id = reader.id OR EXISTS (
    SELECT 1 FROM ancestors a JOIN drive_read_grants g ON g.entry_id = a.id
    WHERE g.recipient_id = reader.id
  ))
)`;

export type PublishedReadReference = Readonly<ImmutableS3Reference & {
  name: string;
  storageConfigId: string;
  sizeBytes: number;
  evidenceRevision: string;
}>;

interface PublishedRow {
  keyHex: string;
  nameHex: string;
  revisionHex: string;
  etag: string;
  sizeBytes: number;
}

/** Server-only. Resolve once per download; never serialize or cache the reference. */
export function createPublishedReadAccess(db: { withSession(constraint: 'first-primary'): Database }, epoch: string, config: S3Config) {
  const { settings: { endpoint, bucket }, storageConfigId } = uploadStorageEvidence(config, epoch);
  return {
    storageConfigId,
    async resolveGeneration(token: string, id: string): Promise<PublishedReadReference | null> {
      if (typeof id !== 'string' || !id || !id.isWellFormed() || id.includes('\0')) return null;
      try {
        const hash = await sessionHash(token);
        if (!hash) return null;
        // Authorize and resolve in the same fresh primary statement. Receipt
        // history alone does not establish that the file is still visible.
        const row = await db.withSession('first-primary').prepare(`${access}
          SELECT hex(g.object_key) AS keyHex, hex(e.name) AS nameHex, g.etag,
            g.size_bytes AS sizeBytes, hex(g.evidence_revision) AS revisionHex
          FROM permitted a JOIN drive_entries e ON e.id = a.id
          JOIN drive_published_generations g ON g.entry_id = e.id AND g.owner_id = e.owner_id
            AND g.object_key = e.object_key AND g.size_bytes = e.size_bytes
          JOIN drive_upload_publications p ON p.entry_id = g.entry_id
            AND p.object_etag = g.etag AND p.size_bytes = g.size_bytes
          WHERE e.kind = 'file' AND g.endpoint = ? AND g.bucket = ? AND g.storage_epoch = ?
            AND NOT EXISTS (SELECT 1 FROM drive_deleted_entries d WHERE d.entry_id = e.id)
            AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones t WHERE t.intent_id = g.intent_id)
            AND NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims c WHERE c.intent_id = g.intent_id)
            AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_quarantine q WHERE q.operation_id = p.completion_operation_id)`)
          .bind(id, hash, id, endpoint, bucket, epoch).first<PublishedRow>();
        if (!row) return null;
        const { etag, sizeBytes } = row;
        if (typeof etag !== 'string' || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) ||
            !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) return null;
        // The ledger defines an opaque 36-character revision, not a UUID version.
        const evidenceRevision = decodeUploadIdentity(row.revisionHex);
        if ([...evidenceRevision].length !== 36 || evidenceRevision.includes('\0')) return null;
        const key = decodeUploadIdentity(row.keyHex);
        if (!key || key.includes('\0') || key.split('/').some((segment) => segment === '.' || segment === '..')) return null;
        const name = decodeUploadIdentity(row.nameHex);
        validateName(name);
        return Object.freeze({ name, key, etag, sizeBytes, storageConfigId, evidenceRevision });
      } catch { return null; }
    }
  };
}

// Listing and entry lookup never expose a storage reference.
export class ReadAccess {
  constructor(private readonly db: Database) {}

  async get(token: string, id: string): Promise<ReadEntry | null> {
    const hash = await sessionHash(token);
    if (!hash) return null;
    return this.db.prepare(`${access} SELECT e.id, e.name, e.kind FROM drive_entries e
      JOIN permitted p ON p.id = e.id`).bind(id, hash, id).first<ReadEntry>();
  }

  async list(token: string, folderId: string, cursor: ReadCursor | null = null): Promise<ReadPage | null> {
    if (cursor !== null && (typeof cursor.name !== 'string' || typeof cursor.id !== 'string')) {
      throw new TypeError('Invalid cursor');
    }
    const hash = await sessionHash(token);
    if (!hash) return null;
    // A sentinel distinguishes an accessible empty folder from an inaccessible ID
    // without an authorization query separate from the listing.
    const boundary = cursor ? 'AND (e.name, e.id) > (?, ?)' : '';
    const rows = (await this.db.prepare(`${access}, folder AS (
      SELECT e.id, e.owner_id FROM drive_entries e JOIN permitted p ON p.id = e.id WHERE e.kind = 'folder'
    ), children AS (
      SELECT e.id, e.name, e.kind FROM drive_entries e INDEXED BY drive_entries_sibling_name
        JOIN folder f ON e.owner_id = f.owner_id
      WHERE COALESCE(e.parent_id, '') = ? ${boundary} ORDER BY e.name, e.id LIMIT 101
    ) SELECT id, name, kind FROM children UNION ALL
      SELECT NULL, NULL, NULL FROM folder ORDER BY name, id`)
      .bind(folderId, hash, folderId, folderId, ...(cursor ? [cursor.name, cursor.id] : []))
      .all<ReadEntry | { id: null; name: null; kind: null }>()).results;
    if (!rows.some((row) => row.id === null)) return null;
    const items = rows.filter((row): row is ReadEntry => row.id !== null);
    const entries = items.slice(0, 100);
    const last = entries[entries.length - 1];
    return { entries, nextCursor: items.length > 100 ? { name: last.name, id: last.id } : null };
  }
}
