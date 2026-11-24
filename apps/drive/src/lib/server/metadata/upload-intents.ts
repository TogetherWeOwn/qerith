import type { LivePrincipalMode } from '../identity/sessions';
import type { firstReleaseSmokePrefix, qualificationPrefix } from '../qualification-scope.mjs';
import { MAX_PART_BYTES } from '../s3/multipart-completion';
import { requireActiveOwner } from './private';

// Server-only reconciliation records. Authenticate the principal before calling;
// neither an intent nor a provider acknowledgement publishes a file.
interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }
export interface UploadAllocationDatabase extends Database {
  batch<T>(statements: Statement[]): Promise<{ results: T[] }[]>;
}

type State = 'created' | 'initiating' | 'allocated' | 'completing' | 'uncertain' | 'acknowledged';
export interface UploadIntent {
  id: string;
  owner_id: string;
  object_key: string;
  upload_id: string | null;
  state: State;
  completion_acknowledged: number;
  version: number;
  declared_size: number | null;
}

export interface ExpectedUploadPart {
  readonly partNumber: number;
  readonly sizeBytes: number;
  readonly sha256: string;
}

type AllocationPrefix = '' | ReturnType<typeof qualificationPrefix> | ReturnType<typeof firstReleaseSmokePrefix>;

export function newUploadObjectKey(prefix: AllocationPrefix = ''): string {
  return prefix + crypto.randomUUID();
}

const maxExpectedUploadBytes = 5 * 1024 ** 3;
const partSha256 = /^[0-9a-f]{64}$/;

function packExpectedParts(size: number, parts: readonly ExpectedUploadPart[]): string {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxExpectedUploadBytes || !Array.isArray(parts) ||
      parts.length !== Math.max(1, Math.ceil(size / MAX_PART_BYTES))) throw new TypeError('Invalid expected upload plan');
  let packed = '';
  for (let offset = 0; offset < parts.length; offset++) {
    const part = parts[offset];
    const { partNumber, sizeBytes, sha256 } = part ?? {};
    if (partNumber !== offset + 1 || sizeBytes !== Math.min(MAX_PART_BYTES, size - offset * MAX_PART_BYTES) ||
        typeof sha256 !== 'string' || sha256.length !== 64 || !partSha256.test(sha256)) {
      throw new TypeError('Invalid expected upload slot');
    }
    packed += sha256;
  }
  return packed;
}

const columns = 'id, owner_id, object_key, upload_id, completion_acknowledged, state, version, declared_size';
const active = 'EXISTS (SELECT 1 FROM drive_active_members WHERE id = ?)';
// Trusted dispatch recovery uses the receipt/quarantine ledger, not legacy journal transitions.
const noTrustedDispatch = `NOT EXISTS (SELECT 1 FROM drive_upload_completion_operations o
  JOIN drive_upload_completion_dispatches d USING (operation_id) WHERE o.intent_id = drive_upload_intents.id)`;

function validateVersion(version: number): void {
  // Reserve a version for recording an uncertain outcome and one for late evidence.
  if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER - 1) {
    throw new TypeError('Invalid upload version');
  }
}

export class UploadIntents<DB extends Database = Database> {
  constructor(private readonly db: DB) {}

  // Bind the namespace before claiming on the same transaction that checks live authority.
  async claimNewAllocation(this: UploadIntents<UploadAllocationDatabase>, principalId: string, sessionHash: string,
    size: number, endpoint: string, bucket: string, epoch: string, ownerOnly = false,
    prefix: AllocationPrefix = ''): Promise<UploadIntent | null> {
    if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('Invalid declared upload size');
    return this.claimAllocation(principalId, sessionHash, size, endpoint, bucket, epoch, ownerOnly, null, prefix);
  }

  // Server-only producer. The caller authenticates and supplies the trusted session
  // hash, storage namespace and admission mode. A proposal is not acknowledgement.
  // There is intentionally no API to attach a proposal to an existing intent.
  async claimNewExpectedAllocation(this: UploadIntents<UploadAllocationDatabase>, principalId: string, sessionHash: string,
    size: number, endpoint: string, bucket: string, epoch: string, mode: LivePrincipalMode,
    parts: readonly ExpectedUploadPart[], prefix: AllocationPrefix = ''): Promise<UploadIntent | null> {
    if (mode !== 'owner' && mode !== 'active') throw new TypeError('Invalid upload admission mode');
    return this.claimAllocation(principalId, sessionHash, size, endpoint, bucket, epoch, mode === 'owner',
      packExpectedParts(size, parts), prefix);
  }

  private async claimAllocation(this: UploadIntents<UploadAllocationDatabase>, principalId: string, sessionHash: string,
    size: number, endpoint: string, bucket: string, epoch: string, ownerOnly: boolean,
    expected: string | null, prefix: AllocationPrefix): Promise<UploadIntent | null> {
    const id = crypto.randomUUID(), key = newUploadObjectKey(prefix);
    const [, , claim] = await this.db.batch<UploadIntent>([
      this.db.prepare(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size${
        expected === null ? '' : ', expected_part_sha256s'})
        SELECT ?, ?, ?, 'created', ?${expected === null ? '' : ', ?'} WHERE ${active} AND EXISTS (SELECT 1 FROM drive_sessions s
          WHERE token_hash = ? AND principal_id = ? AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
            ${requireActiveOwner(ownerOnly, 's.principal_id')})`)
        .bind(id, principalId, key, size, ...(expected === null ? [] : [expected]), principalId, sessionHash, principalId),
      this.db.prepare(`INSERT INTO drive_upload_storage_bindings (intent_id, endpoint, bucket, storage_epoch)
        SELECT id, ?, ?, ? FROM drive_upload_intents WHERE id = ? AND object_key = ?`)
        .bind(endpoint, bucket, epoch, id, key),
      // Only the brand-new row can match; its ID and key cannot be reused.
      this.db.prepare(`UPDATE drive_upload_intents SET state = 'initiating', version = 1
        WHERE id = ? AND object_key = ? AND state = 'created' AND version = 0 RETURNING ${columns}`).bind(id, key)
    ]);
    return claim.results[0] ?? null;
  }

  async create(principalId: string): Promise<UploadIntent | null> {
    return this.insert(principalId, null);
  }

  // A declaration is not evidence of the actual uploaded size.
  async createSized(principalId: string, declaredSize: number): Promise<UploadIntent | null> {
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) throw new TypeError('Invalid declared upload size');
    return this.insert(principalId, declaredSize);
  }

  private async insert(principalId: string, declaredSize: number | null): Promise<UploadIntent | null> {
    return this.db.prepare(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size)
      SELECT ?, ?, ?, 'created', ? WHERE ${active} RETURNING ${columns}`)
      .bind(crypto.randomUUID(), principalId, newUploadObjectKey(), declaredSize, principalId).first<UploadIntent>();
  }

  async get(principalId: string, id: string): Promise<UploadIntent | null> {
    return this.db.prepare(`SELECT ${columns} FROM drive_upload_intents
      WHERE id = ? AND owner_id = ? AND ${active}`)
      .bind(id, principalId, principalId).first<UploadIntent>();
  }

  // A successful claim authorizes one provider attempt. A stale claim never does.
  async claim(principalId: string, id: string, version: number,
    operation: 'allocation' | 'completion'): Promise<UploadIntent | null> {
    validateVersion(version);
    if (operation !== 'allocation' && operation !== 'completion') throw new TypeError('Invalid upload operation');
    // A claim must leave room for uncertainty and its eventual late evidence.
    if (version >= Number.MAX_SAFE_INTEGER - 2) throw new TypeError('Invalid upload version');
    return this.db.prepare(`UPDATE drive_upload_intents SET state = ?, version = version + 1
      WHERE id = ? AND owner_id = ? AND state = ? AND version = ? AND ${active}
        AND NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = drive_upload_intents.id)
        AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_attempts WHERE intent_id = drive_upload_intents.id)
        AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones WHERE intent_id = drive_upload_intents.id)
        AND ${noTrustedDispatch}
      RETURNING ${columns}`)
      .bind(operation === 'allocation' ? 'initiating' : 'completing', id, principalId,
        operation === 'allocation' ? 'created' : 'allocated', version, principalId).first<UploadIntent>();
  }

  // Trusted recovery scans must periodically restart at the beginning; an intent
  // claimed behind the cursor is picked up on the next pass. This is not a lease:
  // quarantining a live attempt is safe, but it must never authorize a retry.
  // Integration must schedule bounded scans and call recordUncertain with each
  // row's owner, id, version and operation; this module does not run a scheduler.
  async listInFlight(afterId: string, limit: number): Promise<UploadIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid recovery limit');
    const page = await this.db.prepare(`SELECT ${columns} FROM drive_upload_intents
      WHERE state IN ('initiating', 'completing') AND id > ? AND ${noTrustedDispatch} ORDER BY id LIMIT ?`)
      .bind(afterId, limit).all<UploadIntent>();
    return page.results;
  }

  // Include revoked owners. For rows quarantined by the transition protocol,
  // upload_id distinguishes completion from allocation and the original claim
  // version is version - 1 (quarantine increments it). Restart after interruption.
  async listUncertain(afterId: string, limit: number): Promise<UploadIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid recovery limit');
    const page = await this.db.prepare(`SELECT ${columns} FROM drive_upload_intents
      WHERE state = 'uncertain' AND id > ? AND ${noTrustedDispatch} ORDER BY id LIMIT ?`)
      .bind(afterId, limit).all<UploadIntent>();
    return page.results;
  }

  // Trusted provider-operation or recovery code only: arguments must come from a
  // successful claim or trusted scan, never directly from a request. Recovery can
  // quarantine after revocation, but it never authorizes a provider retry.
  async recordUncertain(ownerId: string, id: string, version: number,
    operation: 'allocation' | 'completion'): Promise<boolean> {
    validateVersion(version);
    if (operation !== 'allocation' && operation !== 'completion') throw new TypeError('Invalid upload operation');
    const row = await this.db.prepare(`UPDATE drive_upload_intents SET state = 'uncertain', version = version + 1
      WHERE id = ? AND owner_id = ? AND state = ? AND version = ? AND ${noTrustedDispatch} RETURNING id`)
      .bind(id, ownerId, operation === 'allocation' ? 'initiating' : 'completing', version).first<{ id: string }>();
    return row !== null;
  }

  // Trusted reconciliation only; never expose this scan to a principal. Restart
  // from the beginning because revocation or late evidence may occur behind the
  // cursor. A scan result alone does not authorize deletion or provider operations.
  async listRevokedEvidence(afterId: string, limit: number): Promise<UploadIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid recovery limit');
    const page = await this.db.prepare(`SELECT ${columns} FROM drive_upload_intents
      WHERE state IN ('allocated', 'acknowledged') AND id > ?
        AND NOT EXISTS (SELECT 1 FROM drive_active_members WHERE id = owner_id)
      ORDER BY id LIMIT ?`).bind(afterId, limit).all<UploadIntent>();
    return page.results;
  }

  // Trusted provider-operation code only: arguments come from a successful claim
  // or trusted recovery scan, never directly from a request. Record outcomes after
  // revocation without returning reconciliation data to the caller.

  // Retry is safe only if the provider request was definitely never dispatched.
  // A timeout, error response, crash or unknown outcome must use recordUncertain.
  async recordNotDispatched(ownerId: string, id: string, version: number,
    operation: 'allocation' | 'completion'): Promise<boolean> {
    validateVersion(version);
    if (operation !== 'allocation' && operation !== 'completion') throw new TypeError('Invalid upload operation');
    const row = await this.db.prepare(`UPDATE drive_upload_intents SET state = ?, version = version + 1
      WHERE id = ? AND owner_id = ?
        AND ((state = ? AND version = ?) OR (state = 'uncertain' AND version = ?))
        AND ${noTrustedDispatch}
        AND ${operation === 'allocation' ? 'upload_id IS NULL' : 'upload_id IS NOT NULL AND completion_acknowledged = 0'}
      RETURNING id`)
      .bind(operation === 'allocation' ? 'created' : 'allocated', id, ownerId,
        operation === 'allocation' ? 'initiating' : 'completing', version, version + 1).first<{ id: string }>();
    return row !== null;
  }

  async recordSuccess(ownerId: string, id: string, version: number,
    result: { kind: 'allocation'; uploadId: string } | { kind: 'completion' }): Promise<boolean> {
    validateVersion(version);
    if (!result || (result.kind !== 'allocation' && result.kind !== 'completion')
      || (result.kind === 'allocation' && (typeof result.uploadId !== 'string'
        || result.uploadId.length === 0 || result.uploadId.length > 65536))) {
      throw new TypeError('Invalid provider outcome');
    }
    const allocation = result.kind === 'allocation';
    const row = await this.db.prepare(`UPDATE drive_upload_intents
      SET state = ?,
        upload_id = COALESCE(?, upload_id),
        completion_acknowledged = CASE WHEN ? = 'completion' THEN 1 ELSE completion_acknowledged END,
        version = version + 1
      WHERE id = ? AND owner_id = ? AND version < 9007199254740991
        AND ((state = ? AND version = ?) OR (state = 'uncertain' AND version = ?))
        AND ${noTrustedDispatch}
        AND ${allocation ? 'upload_id IS NULL' : 'upload_id IS NOT NULL AND completion_acknowledged = 0'}
      RETURNING id`)
      .bind(allocation ? 'allocated' : 'acknowledged', allocation ? result.uploadId : null,
        result.kind, id, ownerId, allocation ? 'initiating' : 'completing', version, version + 1)
      .first<{ id: string }>();
    return row !== null;
  }
}
