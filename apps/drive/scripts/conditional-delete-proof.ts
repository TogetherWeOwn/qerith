import { listingText, parseListingXml } from '../src/lib/server/s3/listing-xml';
import type { createS3Transport } from '../src/lib/server/s3/transport';

type StorageRequest = ReturnType<typeof createS3Transport>;
type ProbeRequest = Pick<Parameters<StorageRequest>[0], 'signal' | 'maxResponseBytes'> & {
  method: 'GET' | 'DELETE';
  headers?: { 'if-match': string };
};

/** Trusted adapter capability: bound to one exclusively held, freshly created synthetic object. */
export type ConditionalDeleteTarget = Readonly<{
  request: (operation: ProbeRequest) => ReturnType<StorageRequest>;
  versioning: 'never-enabled';
  etag: string;
  bytes: Uint8Array;
}>;

type Phase = 'target' | 'initial-read' | 'wrong-etag' | 'preservation' | 'matching-delete' | 'absence';
export type ConditionalDeleteProof = { passed: true } | { passed: false; phase: Phase };

const errorLimit = 8192; // Matches the app's DELETE response bound.
const strongEtag = /^"[\x21\x23-\x7e\x80-\xff]*"$/;

/** Uncalled by the app/workflows. At most five requests; no retry or cleanup. */
export async function proveConditionalDelete(target: ConditionalDeleteTarget, stop?: AbortSignal): Promise<ConditionalDeleteProof> {
  let phase: Phase = 'target';
  try {
    const { request, versioning, etag, bytes } = target;
    if (versioning !== 'never-enabled' || typeof etag !== 'string' || etag.length > 256 || !strongEtag.test(etag) ||
        !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 1024) return { passed: false, phase };
    const expected = new Uint8Array(bytes);
    const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(stop ? [stop] : [])]);
    const send = async (method: ProbeRequest['method'], maxResponseBytes: number, match?: string) => {
      signal.throwIfAborted();
      const response = await request({ method, maxResponseBytes, signal, ...(match && { headers: { 'if-match': match } }) });
      signal.throwIfAborted();
      if (response.body.length > maxResponseBytes || response.headers.has('x-amz-delete-marker') ||
          response.headers.has('x-amz-version-id')) throw new Error('Invalid conditional-delete evidence');
      return response;
    };
    const pinnedRead = async () => {
      const { status, headers, body } = await send('GET', expected.length, etag);
      return status === 200 && headers.get('etag') === etag && !headers.has('content-encoding') &&
        !headers.has('content-range') && body.length === expected.length && expected.every((byte, i) => byte === body[i]);
    };
    const errorCode = (body: Uint8Array) => listingText(parseListingXml(body, 'Error'), 'Code');

    phase = 'initial-read';
    if (!await pinnedRead()) return { passed: false, phase };
    phase = 'wrong-etag';
    const wrong = await send('DELETE', errorLimit, etag === '"probe-mismatch"' ? '"probe-mismatch-2"' : '"probe-mismatch"');
    if (wrong.status !== 412 || errorCode(wrong.body) !== 'PreconditionFailed') return { passed: false, phase };
    phase = 'preservation';
    if (!await pinnedRead()) return { passed: false, phase };
    phase = 'matching-delete';
    const deleted = await send('DELETE', errorLimit, etag);
    if ((deleted.status !== 200 && deleted.status !== 204) || deleted.body.length !== 0) return { passed: false, phase };
    phase = 'absence';
    // Unconditioned read: a generation mismatch is not evidence of absence.
    const missing = await send('GET', errorLimit);
    if (missing.status !== 404 || errorCode(missing.body) !== 'NoSuchKey') return { passed: false, phase };
    return { passed: true };
  } catch {
    return { passed: false, phase };
  }
}
