import { entryId } from './download-id';

// Match the multipart HTTP contract: 16 MiB per part, at least 5 MiB except for the final part.
const partBytes = 16 * 1024 * 1024;
const maxParts = 10_000;
const multipartFileLimit = 5 * 1024 ** 3;
const request: RequestInit = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
const json = { 'content-type': 'application/json' };

export type RootUploadResult = { status: 'published'; id: string } | { status: 'name-taken' | 'interrupted' };

export function uploadToRoot(file: File, partAccepted: () => void, fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  return upload(file, () => partAccepted(), fetcher, partBytes);
}

export function uploadMultipartToRoot(file: File, partAccepted: (acceptedBytes: number) => void,
  fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  return upload(file, partAccepted, fetcher, multipartFileLimit);
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
      const part = await fetcher(`${path}/parts/${number}`, { ...request, method: 'PUT', body });
      if (part.status !== 204) return interrupted;
      offset = end;
      partAccepted(offset);
    }

    const complete = await fetcher(`${path}/complete`, {
      ...request, method: 'POST', headers: json, body: JSON.stringify({ parentId: null, name: file.name }),
    });
    if (complete.status === 409 && (await complete.json())?.code === 'name-taken') return { status: 'name-taken' };
    if (complete.status !== 201 && complete.status !== 200) return interrupted;
    const publishedId: unknown = (await complete.json())?.id;
    return typeof publishedId === 'string' && entryId.test(publishedId)
      ? { status: 'published', id: publishedId }
      : interrupted;
  } catch {
    // A failed or missing acknowledgement does not make any step safe to resend.
    return interrupted;
  }
}
