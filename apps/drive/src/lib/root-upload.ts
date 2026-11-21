import { entryId } from './download-id';
import { validateName } from './entry-name';
import { hashMultipartFile, isMultipartSize, multipartFileLimit, multipartPartCount, partBytes } from './multipart-upload-plan';
import { verifyBoundUploadResumePrefix, verifyUploadResumePrefix } from './upload-resume-evidence';

const request: RequestInit = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
const json = { 'content-type': 'application/json' };
const destinationLimit = 4096;
// Room for at most 320 records plus 20,480 hex characters at the 5 GiB file limit.
const resumeEvidenceLimit = 64 * 1024;

export type RootUploadResult = { status: 'published'; id: string } | { status: 'name-taken' | 'interrupted' };
declare const boundCandidate: unique symbol;
/** Only the application intent ID, never an object key, provider upload ID, or file data. */
export type UploadResumeCandidate = string & { readonly [boundCandidate]: true };
type Progress = (acceptedBytes: number) => void;
type RetainCandidate = (candidate: UploadResumeCandidate) => void;
const interrupted = Object.freeze({ status: 'interrupted' } as const);

function isCandidate(id: unknown): id is UploadResumeCandidate {
  return typeof id === 'string' && id.length === 36 && entryId.test(id);
}

export function uploadToRoot(file: File, partAccepted: () => void, fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  return upload(file, () => partAccepted(), fetcher, partBytes);
}

export function uploadMultipartToRoot(file: File, partAccepted: Progress, fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  return upload(file, partAccepted, fetcher, multipartFileLimit);
}

/** Allocate a bound intent, without changing the existing picker or fixture. */
export function uploadBoundMultipartToRoot(file: File, partAccepted: Progress, retainCandidate: RetainCandidate,
  fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  return upload(file, partAccepted, fetcher, multipartFileLimit, { retainCandidate });
}

/** Legacy fixture: verify an already complete prefix (or the single empty slot). */
export function resumeMultipartToRoot(intentId: string, file: File, partAccepted: Progress,
  fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  return resume(intentId, file, partAccepted, fetcher, false);
}

/** Continue only the explicit bound intent; never downgrade to unbound evidence. */
export function resumeBoundMultipartToRoot(candidate: UploadResumeCandidate, file: File, partAccepted: Progress,
  fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  return resume(candidate, file, partAccepted, fetcher, true);
}

function rootDestination(file: File): string | null {
  const name = file.name;
  validateName(name);
  const body = JSON.stringify({ parentId: null, name });
  return new TextEncoder().encode(body).length <= destinationLimit ? body : null;
}

async function resume(intentId: string, file: File, partAccepted: Progress, fetcher: typeof fetch,
  bound: boolean): Promise<RootUploadResult> {
  const size = file.size;
  if (!isCandidate(intentId) || !isMultipartSize(size)) return interrupted;
  const path = `/api/uploads/${intentId}`;

  try {
    const response = await fetcher(`${path}/resume`, { ...request, method: 'GET' });
    if (response.status !== 200) return interrupted;
    const verify = bound ? verifyBoundUploadResumePrefix : verifyUploadResumePrefix;
    const prefix = await verify(file, await readJsonWithin(response, resumeEvidenceLimit));
    // Unbound claims protect individual slots, not file identity. Empty bytes are the only exception.
    if (!prefix || (!bound && prefix.bytes !== size)) return interrupted;

    const destination = rootDestination(file);
    if (destination === null) return interrupted;
    if (prefix.parts > 0) partAccepted(prefix.bytes);
    if (!await sendParts(path, file, prefix.parts, partAccepted, fetcher)) return interrupted;
    return await completeUpload(path, destination, fetcher, readCompletion);
  } catch {
    return interrupted;
  }
}

function parseUniqueJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  // With valid syntax, a string followed by a colon is a member name. Match whole
  // strings so braces and colons inside them cannot affect object boundaries.
  const objects: Set<string>[] = [];
  for (const [token, key, colon] of text.matchAll(/("(?:[^"\\]|\\.)*")([ \t\r\n]*:)?|[{}]/gs)) {
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (colon) {
      const keys = objects[objects.length - 1];
      const name = JSON.parse(key) as string;
      if (keys.has(name)) return null;
      keys.add(name);
    }
  }
  return parsed;
}

async function readJsonWithin(response: Response, limit: number): Promise<unknown> {
  if (!response.body || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== json['content-type'])
    return null;
  const reader = response.body.getReader(), bytes = new Uint8Array(limit);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
      if (value.byteLength > limit - offset) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

async function sendParts(path: string, file: File, prefixCount: number, partAccepted: Progress,
  fetcher: typeof fetch): Promise<boolean> {
  const size = file.size;
  const count = multipartPartCount(size);
  for (let index = prefixCount; index < count; index++) {
    const offset = index * partBytes;
    const end = Math.min(offset + partBytes, size);
    const body = count === 1 ? file : file.slice(offset, end);
    const reply = await fetcher(`${path}/parts/${index + 1}`, { ...request, method: 'PUT', body });
    if (reply.status !== 204) return false;
    partAccepted(end);
  }
  return true;
}

const readCompletion = (response: Response) => readJsonWithin(response, destinationLimit);

async function completeUpload(path: string, body: string, fetcher: typeof fetch,
  readJson: (response: Response) => Promise<unknown> = (response) => response.json()): Promise<RootUploadResult> {
  const complete = await fetcher(`${path}/complete`, { ...request, method: 'POST', headers: json, body });
  const { status } = complete;
  if (status === 409 || status === 201 || status === 200) {
    const result = await readJson(complete) as { id?: unknown; code?: unknown } | null;
    if (status === 409) {
      if (result?.code === 'name-taken') return { status: 'name-taken' };
    } else if (typeof result?.id === 'string' && entryId.test(result.id)) {
      return { status: 'published', id: result.id };
    }
  }
  return { status: 'interrupted' };
}

async function upload(file: File, partAccepted: Progress, fetcher: typeof fetch, fileLimit: number,
  bound?: { retainCandidate: RetainCandidate }): Promise<RootUploadResult> {
  const size = file.size;
  if (!isMultipartSize(size) || size > fileLimit) return interrupted;

  try {
    const destination = bound ? rootDestination(file) : undefined;
    if (destination === null) return interrupted;
    const body = bound ? { size, expectedPartSha256s: await hashMultipartFile(file) } : { size };
    const intent = await fetcher('/api/uploads', {
      ...request, method: 'POST', headers: json, body: JSON.stringify(body),
    });
    if (intent.status !== 201) return interrupted;
    const allocation = (bound ? await readJsonWithin(intent, destinationLimit) : await intent.json()) as { id?: unknown } | null;
    const id = allocation?.id;
    if (bound) {
      if (!isCandidate(id)) return interrupted;
      bound.retainCandidate(id);
    } else if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
      // Keep the fixture's opaque ID within a single, literal URL path segment.
      return interrupted;
    }

    const path = `/api/uploads/${id}`;
    if (!await sendParts(path, file, 0, partAccepted, fetcher)) return interrupted;
    return await completeUpload(path, destination ?? JSON.stringify({ parentId: null, name: file.name }),
      fetcher, bound ? readCompletion : undefined);
  } catch {
    // A failed or missing acknowledgement does not make any step safe to resend.
    return interrupted;
  }
}
