import { IoDeadlineExceeded, readBoundedBody } from './bounded-io';
import { prepareUploadPartBytes, type UploadPartByteEvidence,
  type UploadPartByteScope } from './metadata/upload-part-byte-evidence';
import { MAX_PART_BYTES } from './s3/multipart-completion';
import type { createMultipartUpload } from './s3/multipart-upload';

const uploadBodyReadMs = 60_000;
type SendPart = ReturnType<typeof createMultipartUpload>;
type PartReceipt = Awaited<ReturnType<SendPart>>;

interface PartAttempt {
  objectKey: string;
  uploadId: string;
  byteEvidence?: {
    scope: UploadPartByteScope & { objectKey: string; uploadId: string };
    store: Pick<UploadPartByteEvidence, 'recordAcknowledged'>;
  };
  // Null preserves uncertainty; neither result grants permission to send again.
  record(receipt: PartReceipt | null): Promise<void>;
}

export interface UploadPartDependencies {
  authorize(request: Request, intentId: string): Promise<{
    // Atomically recheck live authority and claim this slot. Only a fresh,
    // acknowledged claim grants a send; an existing evidence row never does.
    claim(partNumber: number, size: number, sha256: string | null): Promise<PartAttempt | null>;
  } | null>;
  send: SendPart;
}

const reply = (status: number, body: string | null = null) =>
  new Response(body, { status, headers: { 'cache-control': 'no-store' } });

export const uploadIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export async function readUploadBody(request: Request, size: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const { body, signal } = request;
  if (!body) return size === 0 && !signal.aborted ? new Uint8Array(0) : null;
  try {
    const bytes = await readBoundedBody(body, { signal, timeoutMs: uploadBodyReadMs, maxBytes: size, exact: true });
    return signal.aborted ? null : bytes;
  } catch (error) {
    if ((signal.aborted && Object.is(error, signal.reason)) || error instanceof IoDeadlineExceeded) return null;
    throw error;
  }
}

export async function uploadPart(request: Request, intentId: string, part: string, deps?: UploadPartDependencies): Promise<Response> {
  if (!deps) return reply(503, 'Service unavailable');
  if (request.method !== 'PUT') return reply(405);
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply(403);
  const partNumber = Number(part);
  if (!uploadIdPattern.test(intentId) ||
      !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || String(partNumber) !== part) return reply(400);

  let access;
  try { access = await deps.authorize(request, intentId); } catch { return reply(404); }
  if (!access) return reply(404);
  const length = request.headers.get('content-length');
  if (length === null) return reply(411);
  if (!/^[0-9]+$/.test(length)) return reply(400);
  const size = Number(length);
  if (size > MAX_PART_BYTES) return reply(413);
  const bytes = await readUploadBody(request, size).catch(() => null);
  if (!bytes || request.signal.aborted) return reply(400);
  // A missing digest can pass only the legacy unbound branch of the claim.
  const prepared = await prepareUploadPartBytes(bytes, size).catch(() => null);
  if (request.signal.aborted) return reply(400);

  try {
    const attempt = await access.claim(partNumber, size, prepared?.sha256 ?? null);
    if (!attempt) return reply(404);
    const send = async (key: string, uploadId: string, part: number, body: Uint8Array<ArrayBuffer>) =>
      deps.send(key, uploadId, part, body, request.signal);
    let sent: Promise<PartReceipt> | undefined;
    if (prepared && attempt.byteEvidence) {
      const { scope, store } = attempt.byteEvidence;
      try {
        const proof = await prepared.capture(scope, (target, body) =>
          sent ??= send(target.objectKey, target.uploadId, target.partNumber, body));
        await store.recordAcknowledged(proof);
        return reply(204);
      } catch { /* Fall back to the existing receipt path, never to a second send. */ }
    }
    // Capture can fail before dispatch. Once started, even rejection is final.
    const dispatch = (body: Uint8Array<ArrayBuffer>) => send(attempt.objectKey, attempt.uploadId, partNumber, body);
    const receipt = await (sent ?? (prepared ? prepared.send(dispatch) : dispatch(bytes))).catch(() => null);
    await attempt.record(receipt);
    if (receipt !== null) return reply(204);
  } catch {
    // A lost claim, provider response or receipt acknowledgment is not retry permission.
  }
  return reply(409, 'Upload part outcome unknown');
}
