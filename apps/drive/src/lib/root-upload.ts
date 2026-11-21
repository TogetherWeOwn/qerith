import { entryId } from './download-id';
import { validateName } from './entry-name';
import { verifyUploadResumePrefix } from './upload-resume-evidence';

// Match the multipart HTTP contract: 16 MiB per part, at least 5 MiB except for the final part.
const partBytes = 16 * 1024 * 1024;
const maxParts = 10_000;
const multipartFileLimit = 5 * 1024 ** 3;
const request: RequestInit = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
const json = { 'content-type': 'application/json' };
const destinationLimit = 4096;
// The projection contains at most 320 records at the 5 GiB file limit.
const resumeEvidenceLimit = 64 * 1024;

export type RootUploadResult = { status: 'published'; id: string } | { status: 'name-taken' | 'interrupted' };

export function uploadToRoot(file: File, partAccepted: () => void, fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  return upload(file, () => partAccepted(), fetcher, partBytes);
}

export function uploadMultipartToRoot(file: File, partAccepted: (acceptedBytes: number) => void,
  fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  return upload(file, partAccepted, fetcher, multipartFileLimit);
}

/** Continue only the explicit candidate; no allocation, discovery, or replay. */
export async function resumeMultipartToRoot(intentId: string, file: File, partAccepted: (acceptedBytes: number) => void,
  fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  const interrupted = { status: 'interrupted' } as const;
  const size = file.size;
  // The fixture route admits only canonical lowercase UUIDs. Treat the ID as an opaque path segment.
  if (intentId.length !== 36 || !entryId.test(intentId) ||
      !Number.isSafeInteger(size) || size < 0 || size > multipartFileLimit) return interrupted;
  const path = `/api/uploads/${intentId}`;

  try {
    const response = await fetcher(`${path}/resume`, { ...request, method: 'GET' });
    if (response.status !== 200) return interrupted;
    const prefix = await verifyUploadResumePrefix(file, await readJsonWithin(response, resumeEvidenceLimit));
    if (!prefix || prefix.bytes !== size) return interrupted;

    // A nonempty suffix cannot be filled safely: claims protect individual slots, not file identity.
    // With a declared size of zero there are no competing nonempty bytes to admit. Still require
    // a 204 for the one empty slot if it was not already acknowledged by the evidence.
    const name = file.name;
    validateName(name);
    const destination = JSON.stringify({ parentId: null, name });
    if (destination.length > destinationLimit || new TextEncoder().encode(destination).length > destinationLimit)
      return interrupted;
    if (prefix.parts === 0 && !await putPart(path, 1, file, fetcher)) return interrupted;
    partAccepted(prefix.bytes);
    return await completeUpload(path, destination, fetcher, (reply) => readJsonWithin(reply, destinationLimit));
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

async function putPart(path: string, number: number, body: Blob, fetcher: typeof fetch): Promise<boolean> {
  return (await fetcher(`${path}/parts/${number}`, { ...request, method: 'PUT', body })).status === 204;
}

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

async function upload(file: File, partAccepted: (acceptedBytes: number) => void,
  fetcher: typeof fetch, fileLimit: number): Promise<RootUploadResult> {
  const interrupted = { status: 'interrupted' } as const;
  const size = file.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > fileLimit) return interrupted;
  const partCount = Math.max(1, Math.ceil(size / partBytes));
  if (partCount > maxParts) return interrupted;

  try {
    const intent = await fetcher('/api/uploads', {
      ...request, method: 'POST', headers: json, body: JSON.stringify({ size }),
    });
    if (intent.status !== 201) return interrupted;
    const id: unknown = (await intent.json())?.id;
    // Keep the opaque intent ID within a single, literal URL path segment.
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return interrupted;
    const path = `/api/uploads/${id}`;

    let offset = 0;
    for (let number = 1; number <= partCount; number++) {
      const end = Math.min(offset + partBytes, size);
      const body = partCount === 1 ? file : file.slice(offset, end);
      if (!await putPart(path, number, body, fetcher)) return interrupted;
      offset = end;
      partAccepted(offset);
    }

    return await completeUpload(path, JSON.stringify({ parentId: null, name: file.name }), fetcher);
  } catch {
    // A failed or missing acknowledgement does not make any step safe to resend.
    return interrupted;
  }
}
