import { tokenHash } from './identity/sessions';
import { validateName } from './metadata/private';
import { createUploadCompletionReceipts } from './metadata/upload-completion-receipts';
import { UploadPartOperationEvidence } from './metadata/upload-part-operation-evidence';
import { decodeUploadIdentity, uploadStorageEvidence } from './metadata/upload-storage-evidence';
import { createTrustedUploadPublication } from './metadata/upload-trusted-publication';
import { allowsOrigin, authOrigin, type DriveAuthEnv } from './request-auth';
import type { S3Config } from './s3/config';
import { createMultipartUpload } from './s3/multipart-upload';
import { readUploadBody, uploadIdPattern, uploadPart } from './upload-part';

type Database = Parameters<typeof createUploadCompletionReceipts>[0];
type Statement = ReturnType<Database['prepare']>;
type Verifier = NonNullable<Parameters<typeof createUploadCompletionReceipts>[4]>;
type Session = NonNullable<App.Locals['driveSession']>;

export interface UploadRouteEnv extends DriveAuthEnv {
  DB?: Database & { batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]> };
  DRIVE_UPLOAD_S3?: S3Config;
  DRIVE_UPLOAD_EPOCH?: string;
  // Trusted binding, not a request setting or a boolean deployment flag.
  DRIVE_UPLOAD_VERIFIER?: Verifier;
}

const reply = (status: number) => new Response(null, { status, headers: { 'cache-control': 'private, no-store' } });

const allocated = `FROM drive_upload_intents i JOIN drive_upload_storage_bindings b ON b.intent_id = i.id
  JOIN drive_sessions s ON s.principal_id = i.owner_id JOIN drive_active_members m ON m.id = i.owner_id
  WHERE i.id = ? AND i.owner_id = ? AND s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND b.endpoint = ? AND b.bucket = ? AND b.storage_epoch = ?
    AND i.state = 'allocated' AND i.completion_acknowledged = 0 AND i.upload_id IS NOT NULL
    AND i.version < 9007199254740990 AND i.declared_size IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones WHERE intent_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_attempts WHERE intent_id = i.id)
    AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_operations WHERE intent_id = i.id)`;

async function destination(request: Request): Promise<{ name: string; parentId: string | null }> {
  const length = request.headers.get('content-length') ?? '';
  const size = Number(length);
  if (request.headers.get('content-type') !== 'application/json' || !/^\d{1,4}$/.test(length) || size < 1 || size > 4096) {
    throw new TypeError('Invalid publication body');
  }
  const bytes = await readUploadBody(request, size);
  if (!bytes) throw new TypeError('Invalid publication body');
  const { name, parentId } = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  validateName(name);
  if (parentId !== null && (typeof parentId !== 'string' || !uploadIdPattern.test(parentId))) {
    throw new TypeError('Invalid publication parent');
  }
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
    const ownerId = session.principal.id;
    const token = session.token;
    const bindings = [intentId, ownerId, await tokenHash(token), settings.endpoint, settings.bucket, epoch];
    return { db, bindings, settings, epoch, verifier, ownerId, token, isQualified, storageConfigId };
  }

  return {
    async part(request: Request, session: Session | undefined, intentId: string, number: string): Promise<Response> {
      try {
        const access = await authorize(request, session, intentId);
        if (access instanceof Response) return access;
        const { db, bindings, settings, epoch, ownerId, isQualified, storageConfigId } = access;
        const ledger = new UploadPartOperationEvidence(db);
        return await uploadPart(request, intentId, number, {
          send: createMultipartUpload(settings, transport),
          async authorize() {
            const intent = await db.withSession('first-primary').prepare(`SELECT i.version ${allocated}`)
              .bind(...bindings).first<{ version: number }>();
            if (!intent) return null;
            return { async claim(partNumber, sizeBytes) {
              if (await isQualified(storageConfigId) !== true) return null;
              const operationId = crypto.randomUUID();
              // The permanent part slot is claimed in the same write as the live session check.
              const claim = await db.prepare(`INSERT INTO drive_upload_part_operations
                SELECT ?, i.id, i.owner_id, i.object_key, b.storage_epoch, i.upload_id, i.version, ?, ? ${allocated}
                  AND i.version = ? AND i.declared_size >= ? + COALESCE((SELECT sum(size_bytes)
                    FROM drive_upload_part_operations WHERE intent_id = i.id), 0)
                  AND NOT EXISTS (SELECT 1 FROM drive_upload_part_operations WHERE intent_id = i.id AND part_number = ?)
                RETURNING hex(object_key) AS key_hex, hex(upload_id) AS upload_hex`)
                .bind(operationId, partNumber, sizeBytes, ...bindings, intent.version, sizeBytes, partNumber)
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
        });
      } catch { return reply(503); }
    },

    async complete(request: Request, session: Session | undefined, intentId: string): Promise<Response> {
      let access;
      try { access = await authorize(request, session, intentId); } catch { return reply(503); }
      if (access instanceof Response) return access;
      let target;
      try { target = await destination(request); } catch { return reply(400); }
      const { db, bindings, settings, epoch, ownerId, token, isQualified, verifier } = access;
      const { parentId, name } = target;
      const operationId = crypto.randomUUID();
      try {
        const complete = createUploadCompletionReceipts(db, epoch, settings, transport, {
          isQualified, verifyParts: (upload) => verifier.verifyParts(upload)
        });
        const publisher = createTrustedUploadPublication(db, epoch, settings, transport, isQualified);
        // The seal trigger checks the exact ordered observed slots, declared size
        // and lack of uncertainty. A failed seal rolls back the operation row too.
        const [operation] = await db.batch([
          db.prepare(`INSERT INTO drive_upload_completion_operations
            SELECT ?, i.id, i.owner_id, i.object_key, b.storage_epoch, i.upload_id, i.version ${allocated}
              AND (? IS NULL OR EXISTS (SELECT 1 FROM drive_entries WHERE id = ? AND owner_id = i.owner_id AND kind = 'folder'))`)
            .bind(operationId, ...bindings, parentId, parentId),
          db.prepare(`INSERT INTO drive_upload_sealed_snapshots
            SELECT o.operation_id, (SELECT json_group_array(part_number) FROM
              (SELECT part_number FROM drive_upload_part_operations WHERE intent_id = o.intent_id ORDER BY part_number)),
              i.declared_size FROM drive_upload_completion_operations o JOIN drive_upload_intents i ON i.id = o.intent_id
            WHERE o.operation_id = ?`).bind(operationId)
        ]);
        if (operation.meta.changes !== 1) return reply(404);
        const row = await db.withSession('first-primary').prepare(`SELECT intent_version FROM drive_upload_completion_operations
          WHERE operation_id = ?`).bind(operationId).first<{ intent_version: number }>();
        if (!row || await complete.complete(token, operationId) !== 'recorded') return reply(409);
        const published = await publisher.publish(token, ownerId, intentId, row.intent_version + 1, operationId, parentId, name);
        return published ? Response.json({ id: published.id }, { status: 201, headers: { 'cache-control': 'private, no-store' } }) : reply(409);
      } catch { return reply(409); }
    }
  };
}
