import { tokenHash } from './identity/sessions';
import { validateName } from './metadata/private';
import { accessibleUploadParent, availableUploadDestination, createUploadCompletionReceipts,
  occupiedUploadName } from './metadata/upload-completion-receipts';
import { UploadPartOperationEvidence } from './metadata/upload-part-operation-evidence';
import { decodeUploadIdentity, uploadStorageEvidence } from './metadata/upload-storage-evidence';
import { createTrustedUploadPublication } from './metadata/upload-trusted-publication';
import { allowsOrigin, authOrigin, type DriveAuthEnv } from './request-auth';
import type { S3Config } from './s3/config';
import { MAX_PART_BYTES, MAX_PARTS, MIN_PART_BYTES } from './s3/multipart-completion';
import { createMultipartUpload } from './s3/multipart-upload';
import { readUploadBody, uploadIdPattern, uploadPart } from './upload-part';
type Database = Parameters<typeof createUploadCompletionReceipts>[0];
type Verifier = NonNullable<Parameters<typeof createUploadCompletionReceipts>[4]>;
type Session = NonNullable<App.Locals['driveSession']>;

export interface UploadRouteEnv extends DriveAuthEnv {
  DB?: Database & { batch(statements: ReturnType<Database['prepare']>[]): Promise<unknown> };
  DRIVE_UPLOAD_S3?: S3Config;
  DRIVE_UPLOAD_EPOCH?: string;
  // Full response-body budget attested by the qualifier for this storage identity.
  DRIVE_UPLOAD_VERIFIER?: Verifier & { completionTimeoutMs(storageConfigId: string): number | null };
}

const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers });

const owned = `JOIN drive_sessions s ON s.principal_id = i.owner_id JOIN drive_active_members m ON m.id = i.owner_id
  WHERE i.id = ? AND i.owner_id = ? AND s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)`;
const bound = `FROM drive_upload_intents i JOIN drive_upload_storage_bindings b ON b.intent_id = i.id ${owned}
    AND b.endpoint = ? AND b.bucket = ? AND b.storage_epoch = ?`;
const unfenced = `NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones WHERE intent_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_attempts WHERE intent_id = i.id)`;
const unsealed = `i.state = 'allocated' AND i.completion_acknowledged = 0 AND i.upload_id IS NOT NULL
    AND i.version < 9007199254740990 AND i.declared_size IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_operations WHERE intent_id = i.id)`;
const allocated = `${bound} AND ${unfenced} AND ${unsealed}`;
// The producer views exclude dispatched operations without a verified receipt.
const candidates = `WITH c AS (
  SELECT operation_id, intent_version + 1 AS claim_version, 0 AS recorded, intent_id, owner_id,
    session_hash, endpoint, bucket, storage_epoch FROM drive_upload_sealed_candidates
  UNION ALL SELECT operation_id, claim_version, 1, intent_id, owner_id,
    session_hash, endpoint, bucket, storage_epoch FROM drive_upload_publishable_completions)`;

async function destination(request: Request): Promise<{ name: string; parentId: string | null }> {
  const length = request.headers.get('content-length') ?? '', size = Number(length);
  if (request.headers.get('content-type') !== 'application/json' || !/^\d{1,4}$/.test(length) || size < 1 || size > 4096)
    throw new TypeError('Invalid publication body');
  const bytes = await readUploadBody(request, size);
  if (!bytes) throw new TypeError('Invalid publication body');
  const { name, parentId } = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  validateName(name);
  if (parentId !== null && (typeof parentId !== 'string' || !uploadIdPattern.test(parentId)))
    throw new TypeError('Invalid publication parent');
  return { name, parentId };
}

export function uploadRoutes(env: UploadRouteEnv, transport = { fetch: globalThis.fetch, timeoutMs: 5000 }) {
  async function authorize(request: Request, session: Session | undefined, intentId: string) {
    const origin = authOrigin(env.DRIVE_ORIGIN);
    const { DB: db, DRIVE_UPLOAD_EPOCH: epoch, DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_VERIFIER: verifier } = env;
    if (!origin || !db) return reply(503);
    if (!allowsOrigin(request, origin.origin)) return reply(403);
    if (!session) return reply(401);
    if (!config || !epoch || !verifier) return reply(503);
    if (!uploadIdPattern.test(intentId)) return reply(400);
    const { settings, storageConfigId } = uploadStorageEvidence(config, epoch);
    const isQualified = (id: string) => verifier.isQualified(id);
    if (await isQualified(storageConfigId) !== true) return reply(503);
    const timeoutMs = verifier.completionTimeoutMs?.(storageConfigId);
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) return reply(503);
    const { token, principal: { id: ownerId } } = session;
    const bindings = [intentId, ownerId, await tokenHash(token), settings.endpoint, settings.bucket, epoch];
    return { db, bindings, settings, epoch, verifier, ownerId, token, isQualified, storageConfigId, timeoutMs };
  }
  return {
    async part(request: Request, session: Session | undefined, intentId: string, number: string): Promise<Response> {
      try {
        const access = await authorize(request, session, intentId);
        if (access instanceof Response) return access;
        const { db, bindings, settings, epoch, ownerId, isQualified, storageConfigId } = access;
        const ledger = new UploadPartOperationEvidence(db);
        return await uploadPart(request, intentId, number, {
          send: createMultipartUpload(settings, { ...transport, beforeSend: () => isQualified(storageConfigId) }),
          async authorize() {
            const intent = await db.withSession('first-primary').prepare(`SELECT i.version ${allocated}`)
              .bind(...bindings).first<{ version: number }>();
            if (!intent) return null;
            return { async claim(partNumber, sizeBytes) {
              if (await isQualified(storageConfigId) !== true) return null;
              const operationId = crypto.randomUUID();
              // Unused slots are optional; only the highest present part may be short.
              const claim = await db.prepare(`INSERT INTO drive_upload_part_operations
                SELECT ?, i.id, i.owner_id, i.object_key, b.storage_epoch, i.upload_id, i.version, ?, ? ${allocated}
                  AND i.version = ? AND NOT EXISTS (SELECT 1 FROM drive_upload_part_operations p
                    LEFT JOIN drive_upload_part_observations r ON r.operation_id = p.operation_id AND r.kind = 'uncertain'
                    WHERE p.intent_id = i.id AND (p.part_number = ? OR r.operation_id IS NOT NULL))
                  AND EXISTS (SELECT sum(size_bytes) FROM (
                    SELECT ? AS part_number, ? AS size_bytes UNION ALL
                    SELECT part_number, size_bytes FROM drive_upload_part_operations WHERE intent_id = i.id)
                    HAVING sum(size_bytes < ${MIN_PART_BYTES}) <= 1 AND max(CASE WHEN size_bytes < ${MIN_PART_BYTES}
                      THEN part_number ELSE 0 END) IN (0, max(part_number))
                    AND (i.declared_size = sum(size_bytes) OR i.declared_size - sum(size_bytes) BETWEEN
                      CASE WHEN min(size_bytes) >= ${MIN_PART_BYTES} AND max(part_number) < ${MAX_PARTS} THEN 1 ELSE ${MIN_PART_BYTES} END
                      AND ${MAX_PART_BYTES} * (CASE WHEN min(size_bytes) < ${MIN_PART_BYTES} THEN max(part_number) ELSE ${MAX_PARTS} END - count(*))))
                RETURNING hex(object_key) AS key_hex, hex(upload_id) AS upload_hex`)
                .bind(operationId, partNumber, sizeBytes, ...bindings, intent.version, partNumber, partNumber, sizeBytes)
                .first<{ key_hex: string; upload_hex: string }>();
              if (!claim) return null;
              const objectKey = decodeUploadIdentity(claim.key_hex), uploadId = decodeUploadIdentity(claim.upload_hex);
              if ([objectKey, uploadId].some((value) => !value || value.includes('\0'))) throw new TypeError('Invalid storage identity');
              const operation = { operationId, intentId, ownerId, objectKey, storageEpoch: epoch,
                uploadId, intentVersion: intent.version, partNumber, sizeBytes };
              return { objectKey, uploadId, record: (receipt) => ledger.recordObservation(operation,
                receipt ? Uint8Array.from(receipt.etag, (char) => char.charCodeAt(0)) : null) };
            } };
          }
        }).then(({ status }) => reply(status));
      } catch { return reply(503); }
    },
    async complete(request: Request, session: Session | undefined, intentId: string): Promise<Response> {
      const access = await authorize(request, session, intentId).catch(() => reply(503));
      if (access instanceof Response) return access;
      const target = await destination(request).catch(() => null);
      if (!target) return reply(400);
      const { db, bindings, settings, epoch, ownerId, token, isQualified, verifier, timeoutMs } = access;
      const { parentId, name } = target, operationId = crypto.randomUUID();
      const destinationBindings = [parentId, parentId, parentId, name];
      let fallback = 409;
      try {
        await db.batch([
          db.prepare(`INSERT INTO drive_upload_completion_operations
            SELECT ?, i.id, i.owner_id, i.object_key, b.storage_epoch, i.upload_id, i.version ${allocated}
              AND ${availableUploadDestination('i.owner_id')}`).bind(operationId, ...bindings, ...destinationBindings),
          db.prepare(`INSERT INTO drive_upload_sealed_snapshots
            SELECT o.operation_id, (SELECT json_group_array(part_number) FROM
              (SELECT part_number FROM drive_upload_part_operations WHERE intent_id = o.intent_id ORDER BY part_number)),
              i.declared_size FROM drive_upload_completion_operations o JOIN drive_upload_intents i ON i.id = o.intent_id
            WHERE o.operation_id = ?`).bind(operationId)
        ]);
        const row = await db.withSession('first-primary').prepare(`${candidates}
          SELECT operation_id, claim_version, recorded FROM c
          WHERE intent_id = ? AND owner_id = ? AND session_hash = ? AND endpoint = ? AND bucket = ? AND storage_epoch = ?
            AND ${availableUploadDestination('c.owner_id')}`)
          .bind(...bindings, ...destinationBindings).first<{ operation_id: string; claim_version: number; recorded: number }>();
        if (!row) fallback = 404;
        else if (row.recorded || await createUploadCompletionReceipts(db, epoch, settings, { ...transport, timeoutMs }, verifier)
          .complete(token, row.operation_id, target) === 'recorded') {
          const publisher = createTrustedUploadPublication(db, epoch, settings, transport, isQualified);
          const published = await publisher.publish(token, ownerId, intentId, row.claim_version, row.operation_id, parentId, name);
          if (published) return Response.json({ id: published.id }, { status: 201, headers });
        }
      } catch { /* Classify from durable state, not provider or constraint error text. */ }

      try {
        // Take one primary snapshot of live access, prior success and sibling occupancy.
        // This also covers a sibling winning at the atomic dispatch or publication write.
        const state = await db.withSession('first-primary').prepare(`${candidates} SELECT (
          SELECT p.entry_id FROM drive_upload_publications p JOIN drive_published_generations g ON g.entry_id = p.entry_id
          JOIN drive_entries e ON e.id = p.entry_id AND e.owner_id = p.owner_id
          WHERE p.intent_id = i.id AND p.owner_id = i.owner_id AND g.endpoint = b.endpoint AND g.bucket = b.bucket
            AND g.storage_epoch = b.storage_epoch AND p.parent_id IS ? AND p.name = ?
        ) AS published_id, (${occupiedUploadName('i.owner_id')} AND ${unfenced} AND (
          (${unsealed} AND NOT EXISTS (SELECT 1 FROM drive_upload_part_operations p
            JOIN drive_upload_part_observations r USING (operation_id) WHERE p.intent_id = i.id AND r.kind = 'uncertain'))
          OR EXISTS (SELECT 1 FROM c WHERE c.intent_id = i.id AND c.owner_id = i.owner_id AND c.session_hash = s.token_hash)
        )) AS name_taken ${bound} AND ${accessibleUploadParent('i.owner_id')}`)
          .bind(parentId, name, parentId, name, ...bindings, parentId, parentId)
          .first<{ published_id: string | null; name_taken: number }>();
        if (!state) return reply(404);
        if (state.published_id) return Response.json({ id: state.published_id }, { headers });
        if (state.name_taken) return Response.json({ code: 'name-taken' }, { status: 409, headers });
      } catch { /* An unavailable read cannot establish a conflict. */ }
      return reply(fallback);
    }
  };
}
