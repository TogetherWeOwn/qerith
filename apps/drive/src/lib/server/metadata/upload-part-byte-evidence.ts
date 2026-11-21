import { MAX_PART_BYTES, MAX_PARTS } from '../s3/multipart-completion';
import type { createMultipartUpload } from '../s3/multipart-upload';
import { bindUploadPartOperation, copyBytes, exactOperation, isText, typedArrayTag,
  type UploadPartOperation, type UploadPartOperationEvidence } from './upload-part-operation-evidence';

type Database = ConstructorParameters<typeof UploadPartOperationEvidence>[0];
export interface UploadPartByteScope extends UploadPartOperation {
  endpoint: string;
  bucket: string;
}
type SendTarget = Readonly<Pick<UploadPartByteScope, 'endpoint' | 'bucket' | 'storageEpoch' | 'partNumber'> & {
  objectKey: string;
  uploadId: string;
}>;
type PartReceipt = Awaited<ReturnType<ReturnType<typeof createMultipartUpload>>>;
type SendPart = (target: SendTarget, bytes: Uint8Array<ArrayBuffer>) => Promise<PartReceipt>;

declare const acknowledged: unique symbol;
export type AcknowledgedUploadPartBytes = { readonly [acknowledged]: true };
const captured = new WeakMap<AcknowledgedUploadPartBytes, (string | number | ArrayBuffer)[]>();
const exactScope = `${exactOperation} AND o.endpoint = ? AND o.bucket = ?`;

function bindScope(scope: UploadPartByteScope) {
  if (!isText(scope.endpoint) || !isText(scope.bucket)) throw new TypeError('Invalid part storage binding');
  return [...bindUploadPartOperation(scope), scope.endpoint, scope.bucket];
}

function snapshot(bytes: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  if (typedArrayTag.call(bytes) !== 'Uint8Array' || size < 0 || size > MAX_PART_BYTES ||
      Reflect.get(Uint8Array.prototype, 'byteLength', bytes) !== size) throw new TypeError('Invalid upload part bytes');
  return new Uint8Array(copyBytes(bytes, size));
}

const hexDigest = (digest: ArrayBuffer) =>
  Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
type PartScope = UploadPartByteScope & { objectKey: string; uploadId: string };

// Hash before claiming, keeping the snapshot private until the trusted sender
// forwards it unchanged. Neither preparation nor capture grants dispatch.
export async function prepareUploadPartBytes(bytes: Uint8Array, size: number) {
  const body = snapshot(bytes, size);
  const digest = await crypto.subtle.digest('SHA-256', body);
  return {
    sha256: hexDigest(digest),
    send: (send: (body: Uint8Array<ArrayBuffer>) => Promise<PartReceipt>) => send(body),
    capture: (scope: PartScope, send: SendPart) => capture(scope, body, digest, send)
  };
}

export async function captureUploadPartAcknowledgement(scope: PartScope, bytes: Uint8Array, send: SendPart) {
  scope = { ...scope };
  return (await prepareUploadPartBytes(bytes, scope.sizeBytes)).capture(scope, send);
}

async function capture(scope: PartScope, body: Uint8Array<ArrayBuffer>, digest: ArrayBuffer,
  send: SendPart): Promise<AcknowledgedUploadPartBytes> {
  const identity = bindScope(scope);
  const { endpoint, bucket, storageEpoch, objectKey, uploadId, partNumber, sizeBytes } = scope;
  if (!isText(objectKey) || !isText(uploadId) || partNumber < 1 || partNumber > MAX_PARTS || sizeBytes !== body.byteLength)
    throw new TypeError('Invalid upload part target');
  const receipt = await send(Object.freeze({ endpoint, bucket, storageEpoch, objectKey, uploadId, partNumber }), body);
  if (receipt.partNumber !== partNumber || receipt.size !== sizeBytes || typeof receipt.etag !== 'string' ||
      receipt.etag.length > 8192 || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(receipt.etag)) {
    throw new TypeError('Invalid upload part acknowledgement');
  }
  const tag = Uint8Array.from(receipt.etag, (char) => char.charCodeAt(0));
  const proof = Object.freeze({}) as AcknowledgedUploadPartBytes;
  captured.set(proof, [digest, tag.buffer, ...identity]);
  return proof;
}

export class UploadPartByteEvidence {
  constructor(private readonly db: Database) {}

  // Replaces recordObservation only for a successful send. A rejected write is
  // never grounds to dispatch again, including a duplicate of the same proof.
  async recordAcknowledged(proof: AcknowledgedUploadPartBytes): Promise<void> {
    const bindings = captured.get(proof);
    if (!bindings) throw new TypeError('Invalid upload part proof');
    const row = await this.db.prepare(`INSERT INTO drive_upload_part_byte_evidence (operation_id, sha256, reported_etag)
      SELECT o.operation_id, ?, ? FROM drive_upload_resumable_part_operations o WHERE ${exactScope}
      RETURNING operation_id`).bind(...bindings).first();
    if (!row) throw new Error('No matching live upload part operation');
  }

  // Metadata only, not authorization. The runtime must independently authorize
  // the owner and compare the actual candidate span, not client assertions.
  async readAcknowledged(scope: UploadPartByteScope): Promise<{ sha256: string } | null> {
    return this.read(bindScope({ ...scope }));
  }

  async matches(scope: UploadPartByteScope, bytes: Uint8Array): Promise<boolean> {
    scope = { ...scope };
    const identity = bindScope(scope);
    const digest = await crypto.subtle.digest('SHA-256', snapshot(bytes, scope.sizeBytes));
    return (await this.read(identity))?.sha256 === hexDigest(digest);
  }

  private read(identity: ReturnType<typeof bindScope>) {
    // A failed primary read does not establish a match or permission to send.
    return this.db.withSession('first-primary').prepare(`SELECT lower(hex(e.sha256)) AS sha256
      FROM drive_upload_resumable_part_operations o JOIN drive_upload_part_byte_evidence e USING (operation_id)
      JOIN drive_upload_part_observations r USING (operation_id)
      WHERE r.kind = 'reported' AND r.reported_etag = e.reported_etag AND ${exactScope}`)
      .bind(...identity).first<{ sha256: string }>();
  }
}
