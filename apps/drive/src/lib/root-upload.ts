import { entryId } from './download-id';

const maxUploadBytes = 16 * 1024 * 1024;
const request: RequestInit = { mode: 'same-origin', credentials: 'same-origin', cache: 'no-store', redirect: 'error' };
const json = { 'content-type': 'application/json' };

export type RootUploadResult = { status: 'published'; id: string } | { status: 'name-taken' | 'interrupted' };

export async function uploadToRoot(file: File, partAccepted: () => void, fetcher: typeof fetch = fetch): Promise<RootUploadResult> {
  const interrupted = { status: 'interrupted' } as const;
  if (file.size > maxUploadBytes) return interrupted;

  try {
    const intent = await fetcher('/api/uploads', {
      ...request, method: 'POST', headers: json, body: JSON.stringify({ size: file.size }),
    });
    if (intent.status !== 201) return interrupted;
    const id: unknown = (await intent.json())?.id;
    // Keep the opaque intent ID within a single, literal URL path segment.
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return interrupted;
    const path = `/api/uploads/${id}`;

    const part = await fetcher(`${path}/parts/1`, { ...request, method: 'PUT', body: file });
    if (part.status !== 204) return interrupted;
    partAccepted();

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
