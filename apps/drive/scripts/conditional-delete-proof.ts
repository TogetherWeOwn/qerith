import { listingText, parseListingXml } from '../src/lib/server/s3/listing-xml';
import type { createS3Transport } from '../src/lib/server/s3/transport';

type StorageRequest = ReturnType<typeof createS3Transport>;
type IfMatch = { 'if-match': string };
type ProbeOperation = { maxResponseBytes: number } & (
  | { method: 'GET'; cache: 'no-store'; headers?: IfMatch }
  | { method: 'DELETE'; headers: IfMatch }
);

/** Trusted adapter capability: bound to one exclusively held, freshly created synthetic object. */
export type ConditionalDeleteTarget = Readonly<{
  /** Each GET must independently bypass caches and go to the authoritative provider endpoint. */
  request: (operation: ProbeOperation & { signal: AbortSignal }) => ReturnType<StorageRequest>;
  versioning: 'never-enabled';
  readConsistency: 'authoritative';
  etag: string;
  /** A distinct, provider-valid strong ETag obtained from trusted synthetic setup. */
  wrongEtag: string;
  /** Compare the XML-decoded key exactly to the same key closed over by request. */
  matchesBoundKey: (reportedKey: string) => boolean;
  bytes: Uint8Array;
}>;

type Phase = 'target' | 'initial-read' | 'wrong-etag' | 'preservation' | 'matching-delete' | 'absence';
export type ConditionalDeleteProof = { passed: true } | { passed: false; phase: Phase };

const errorLimit = 8192; // Matches the app's DELETE response bound.
const strongEtag = (tag: unknown): tag is string =>
  typeof tag === 'string' && tag.length <= 256 && /^"[\x21\x23-\x7e\x80-\xff]+"$/.test(tag);

/** Uncalled by the app/workflows. At most five requests; no retry or cleanup. */
export async function proveConditionalDelete(target: ConditionalDeleteTarget, stop?: AbortSignal): Promise<ConditionalDeleteProof> {
  let phase: Phase = 'target';
  try {
    const { request, versioning, readConsistency, etag, wrongEtag, matchesBoundKey, bytes } = target;
    if (versioning !== 'never-enabled' || readConsistency !== 'authoritative' || typeof matchesBoundKey !== 'function' ||
        !strongEtag(etag) || !strongEtag(wrongEtag) || etag === wrongEtag ||
        !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 1024) return { passed: false, phase };
    const expected = new Uint8Array(bytes);
    const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(stop ? [stop] : [])]);
    const send = async (operation: ProbeOperation) => {
      signal.throwIfAborted();
      const response = await request({ ...operation, signal });
      signal.throwIfAborted();
      if (response.body.length > operation.maxResponseBytes || response.headers.has('x-amz-delete-marker') ||
          response.headers.has('x-amz-version-id')) throw new Error('Invalid conditional-delete evidence');
      return response;
    };
    const pinnedRead = async () => {
      const { status, headers, body } = await send({
        method: 'GET', cache: 'no-store', maxResponseBytes: expected.length, headers: { 'if-match': etag },
      });
      return status === 200 && headers.get('etag') === etag && !headers.has('content-encoding') &&
        !headers.has('content-range') && body.length === expected.length && expected.every((byte, i) => byte === body[i]);
    };
    const deleteIfMatch = (pin: string) => send({ method: 'DELETE', maxResponseBytes: errorLimit, headers: { 'if-match': pin } });
    const isBoundError = (body: Uint8Array, code: string) => {
      const error = parseListingXml(body, 'Error');
      if (listingText(error, 'Code') !== code) return false;
      const reportedKey = listingText(error, 'Key', false);
      // Do not confuse a nested or foreign-namespace Key with an omitted Key.
      if (error.getElementsByTagNameNS('*', 'Key').length !== (reportedKey === undefined ? 0 : 1)) return false;
      return reportedKey === undefined || (reportedKey !== '' && matchesBoundKey(reportedKey) === true);
    };

    phase = 'initial-read';
    if (!await pinnedRead()) return { passed: false, phase };
    phase = 'wrong-etag';
    const wrong = await deleteIfMatch(wrongEtag);
    if (wrong.status !== 412 || !isBoundError(wrong.body, 'PreconditionFailed')) return { passed: false, phase };
    phase = 'preservation';
    if (!await pinnedRead()) return { passed: false, phase };
    phase = 'matching-delete';
    const deleted = await deleteIfMatch(etag);
    const length = deleted.headers.get('content-length');
    if ((deleted.status !== 200 && deleted.status !== 204) || deleted.body.length !== 0 ||
        (length !== null && length !== '0')) return { passed: false, phase };
    phase = 'absence';
    // Unconditioned read: a generation mismatch is not evidence of absence.
    const missing = await send({ method: 'GET', cache: 'no-store', maxResponseBytes: errorLimit });
    if (missing.status !== 404 || !isBoundError(missing.body, 'NoSuchKey')) return { passed: false, phase };
    return { passed: true };
  } catch {
    return { passed: false, phase };
  }
}
