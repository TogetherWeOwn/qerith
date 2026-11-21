import type { S3Config } from '../s3/config';
import type { ImmutableS3Reference } from '../s3/objects';
import { decodeCursor, encodeCursor, folderScope, type ListingDirection } from './listing-cursor';
import { validateName } from './private';
import { publishedGenerationFilter, publishedGenerationJoins } from './published-generation-sql';
import { decodeUploadIdentity, uploadStorageEvidence } from './upload-storage-evidence';

interface Statement {
  bind(...values: string[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

export interface ReadEntry { id: string; name: string; kind: 'file' | 'folder' }
export interface ReadCursor { name: string; id: string }
type ListedReadEntry = ReadEntry & { downloadable?: 0 | 1 };
export interface ReadPage { entries: ListedReadEntry[]; nextCursor: ReadCursor | null; ownsFolder: boolean }
export interface FolderPage {
  entries: ReadEntry[];
  total: number;
  order: 'binary-name';
  direction: ListingDirection;
  nextCursor: string | null;
}
export class InvalidFolderPage extends TypeError {}

type FolderPageRow = (ReadEntry & { total: null }) | { id: null; name: null; kind: null; total: number };
const pageSize = 200;

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
async function sessionHash(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const sessionRemainingMs = "s.expires_at - CAST(unixepoch('subsec') * 1000 AS INTEGER)";

// Anchor at the requested entry, not at a previously authorized ancestor. Each
// statement rechecks both parties and the session against the current tree.
const entryAccess = (projection = '') => `WITH RECURSIVE ancestors(id, parent_id, owner_id) AS (
  SELECT id, parent_id, owner_id FROM drive_entries WHERE id = ?
  UNION
  SELECT e.id, e.parent_id, e.owner_id FROM drive_entries e
    JOIN ancestors a ON e.id = a.parent_id AND e.owner_id = a.owner_id
), permitted AS (
  SELECT target.id${projection} FROM drive_entries target
  JOIN drive_principals owner ON owner.id = target.owner_id AND owner.status = 'active'
  JOIN drive_sessions s ON s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  JOIN drive_principals reader ON reader.id = s.principal_id AND reader.status = 'active'
  WHERE target.id = ? AND (target.owner_id = reader.id OR EXISTS (
    SELECT 1 FROM ancestors a JOIN drive_read_grants g ON g.entry_id = a.id
    WHERE g.recipient_id = reader.id
  ))
)`;

const access = entryAccess();
const folderAccess = entryAccess(', target.owner_id = reader.id AS owned');
const publishedGrantAccess = entryAccess(`, ${sessionRemainingMs} AS remainingMs`);

const ownAccess = (allowMembers: boolean) => `WITH permitted AS (
  SELECT e.id, ${sessionRemainingMs} AS remainingMs FROM drive_entries e
  JOIN drive_sessions s ON s.principal_id = e.owner_id
  JOIN drive_principals p ON p.id = s.principal_id AND p.status = 'active'
    AND ${allowMembers ? "p.role IN ('owner', 'member')" : "p.role = 'owner'"}
  WHERE e.id = ? AND s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
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
  remainingMs: number;
}

/** Compatibility: false allows grants; true requires the owner role on an own file. */
export type PublishedReadMode = boolean | 'own-file' | 'grant-aware';

/** Server-only. Use fresh primary reads; never serialize or cache the reference. */
export function createPublishedReadAccess(db: { withSession(constraint: 'first-primary'): Database }, epoch: string, config: S3Config,
  mode: PublishedReadMode = false) {
  const ownFileOnly = mode !== false && mode !== 'grant-aware';
  const permitted = ownFileOnly ? ownAccess(mode === 'own-file') : publishedGrantAccess;
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
        const scope = ownFileOnly ? [id, hash] : [id, hash, id];
        const started = performance.now();
        const row = await db.withSession('first-primary').prepare(`${permitted}
          SELECT hex(g.object_key) AS keyHex, hex(e.name) AS nameHex, g.etag,
            g.size_bytes AS sizeBytes, hex(g.evidence_revision) AS revisionHex, a.remainingMs
          FROM permitted a JOIN drive_entries e ON e.id = a.id
          ${publishedGenerationJoins}
          WHERE ${publishedGenerationFilter}`)
          .bind(...scope, endpoint, bucket, epoch).first<PublishedRow>();
        // D1 measured the budget at statement time. Charge the whole round trip.
        if (!row || !(performance.now() - started < (row.remainingMs ?? 0))) return null;
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

type SharedReadEntry = ReadEntry & { downloadable?: 0 | 1 };
export interface SharedReadPage { entries: SharedReadEntry[]; nextCursor: string | null }
const sharedPageSize = 100;

/** Server-only. List explicit grant roots in binary ID order, not inherited descendants. */
export function createSharedReadAccess(db: { withSession(constraint: 'first-primary'): Database },
  downloadScope?: readonly [endpoint: string, bucket: string, epoch: string]) {
  const availability = downloadScope ? `, EXISTS (SELECT 1 FROM drive_entries e ${publishedGenerationJoins}
    WHERE e.id = entry.id AND ${publishedGenerationFilter}) AS downloadable` : '';
  return {
    async listShared(token: string, afterId: string | null = null): Promise<SharedReadPage> {
      const hash = await sessionHash(token);
      if (!hash) return { entries: [], nextCursor: null };
      if (afterId !== null && typeof afterId !== 'string') throw new TypeError('Invalid shared page cursor');
      // Bind the stored ID verbatim; it need not be formatted like a UUID.
      // The cursor is only a seek boundary; every page reads live authorization
      // on the primary. The recipient index carries entry_id as its PK suffix.
      const { results } = await db.withSession('first-primary').prepare(`
        SELECT entry.id, entry.name, entry.kind${availability} FROM drive_read_grants g INDEXED BY drive_read_grants_recipient
        JOIN drive_entries entry ON entry.id = g.entry_id
        JOIN drive_principals owner ON owner.id = entry.owner_id AND owner.status = 'active'
        WHERE g.recipient_id = (
          SELECT reader.id FROM drive_sessions s
          JOIN drive_principals reader ON reader.id = s.principal_id AND reader.status = 'active' AND reader.role = 'member'
          WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        ) AND g.entry_id > ? AND entry.owner_id != g.recipient_id
        ORDER BY g.entry_id LIMIT ${sharedPageSize + 1}`)
        .bind(...(downloadScope ?? []), hash, afterId ?? '').all<SharedReadEntry>();
      const entries = results.slice(0, sharedPageSize);
      return { entries, nextCursor: results.length > sharedPageSize ? entries[sharedPageSize - 1].id : null };
    }
  };
}

// Listing and entry lookup never expose a storage reference.
export class ReadAccess {
  constructor(private readonly db: Database,
    private readonly downloadScope?: readonly [endpoint: string, bucket: string, epoch: string]) {}

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
    // The sentinel distinguishes a readable empty folder from an inaccessible one.
    // Ownership comes from the same live check as the same-owner child listing.
    const boundary = cursor ? 'AND (e.name, e.id) > (?, ?)' : '';
    // Compute a hint on the same authorized, bounded page. The download route reauthorizes.
    const availability = this.downloadScope ? `, EXISTS (SELECT 1 FROM drive_entries e ${publishedGenerationJoins}
      WHERE e.id = children.id AND ${publishedGenerationFilter}) AS downloadable` : '';
    const sentinelAvailability = this.downloadScope ? ', 0' : '';
    const rows = (await this.db.prepare(`${folderAccess}, folder AS (
      SELECT e.owner_id, p.owned FROM drive_entries e JOIN permitted p ON p.id = e.id WHERE e.kind = 'folder'
    ), children AS (
      SELECT e.id, e.name, e.kind FROM drive_entries e INDEXED BY drive_entries_sibling_name
        JOIN folder f ON e.owner_id = f.owner_id
      WHERE COALESCE(e.parent_id, '') = ? ${boundary} ORDER BY e.name, e.id LIMIT 101
    ) SELECT id, name, kind, NULL AS owned${availability} FROM children UNION ALL
      SELECT NULL, NULL, NULL, owned${sentinelAvailability} FROM folder ORDER BY name, id`)
      .bind(folderId, hash, folderId, folderId, ...(cursor ? [cursor.name, cursor.id] : []), ...(this.downloadScope ?? []))
      .all<(ListedReadEntry & { owned: null }) | { id: null; name: null; kind: null; owned: 0 | 1 }>()).results;
    const sentinel = rows.find(row => row.id === null);
    if (!sentinel) return null;
    const items = rows.filter(row => row.id !== null);
    const entries = items.slice(0, 100).map(({ id, name, kind, downloadable }) =>
      downloadable === undefined ? { id, name, kind } : { id, name, kind, downloadable });
    const last = entries[entries.length - 1];
    return { entries, ownsFolder: sentinel.owned === 1, nextCursor: items.length > 100 ? { name: last.name, id: last.id } : null };
  }

  async listPage(token: string, folderId: string, cursor: string | null = null, direction: ListingDirection = 'asc'): Promise<FolderPage | null> {
    const hash = await sessionHash(token);
    if (!hash) return null;
    const validDirection = direction === 'asc' || direction === 'desc';
    const scope = cursor !== null && validDirection ? await folderScope(folderId) : null;
    const boundary = cursor !== null && scope !== null ? decodeCursor(cursor, scope, direction) : null;
    const invalid = !validDirection || (cursor !== null && boundary === null);
    const [index, order, comparator] = direction === 'desc'
      ? ['drive_entries_listing_desc', 'DESC', '<'] : ['drive_entries_listing_asc', 'ASC', '>'];
    const ordered = `ORDER BY kind DESC, name COLLATE BINARY ${order}, id ASC`;
    const limit = `${ordered} LIMIT ${pageSize + 1}`;
    const children = `SELECT id, name, kind FROM drive_entries INDEXED BY ${index}
      WHERE owner_id = (SELECT owner_id FROM folder) AND parent_id = ?`;
    // Separate ranges let the index seek within a kind. Binary sibling names
    // are unique, so the cursor needs neither a row lookup nor an ID tie-break.
    const ranges = boundary ? `same_kind AS (
      ${children} AND kind = ? AND name COLLATE BINARY ${comparator} ? ${limit}
    ), later_kind AS (
      ${children} AND kind < ? ${limit}
    ), children AS (
      SELECT * FROM (SELECT * FROM same_kind UNION ALL SELECT * FROM later_kind) ${limit}
    )` : `children AS (${children} ${invalid ? 'AND 0' : ''} ${limit})`;
    // The sentinel distinguishes an authorized empty folder from unavailable
    // input and carries its live count in the same snapshot as the page rows.
    const { results: rows } = await this.db.prepare(`${access}, folder AS (
      SELECT e.id, e.owner_id FROM drive_entries e JOIN permitted p ON p.id = e.id WHERE e.kind = 'folder'
    ), ${ranges} SELECT id, name, kind, NULL AS total FROM children UNION ALL
      SELECT NULL, NULL, NULL, counts.item_count FROM folder
        JOIN drive_folder_counts counts ON counts.folder_id = folder.id
      ${ordered}`)
      .bind(folderId, hash, folderId, folderId, ...(boundary ? [boundary.kind, boundary.name, folderId, boundary.kind] : []))
      .all<FolderPageRow>();
    const sentinel = rows.find(row => row.id === null);
    if (!sentinel) return null;
    if (invalid) throw new InvalidFolderPage('Invalid cursor or direction');
    const items = rows.filter(row => row.id !== null);
    const entries = items.slice(0, pageSize).map(({ id, name, kind }) => ({ id, name, kind }));
    const nextCursor = items.length > pageSize
      ? encodeCursor(entries[pageSize - 1], scope ?? await folderScope(folderId), direction) : null;
    return { entries, total: sentinel.total, order: 'binary-name', direction, nextCursor };
  }
}
