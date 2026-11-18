import type { createImmutableS3Reader, ImmutableS3Reference } from './s3/objects';
import { validateRange } from './s3/range';

type Generation = ImmutableS3Reference & { storageConfigId: string; evidenceRevision: string; sizeBytes: number };

export interface DownloadDependencies<Access> {
  authorize(request: Request, fileId: string): Promise<Access | null>;
  // Resolve this authorized file's committed receipt, never client input or a bare S3 HEAD.
  resolveGeneration(access: Access, fileId: string): Promise<Generation | null>;
  readerFor(storageConfigId: string): Pick<ReturnType<typeof createImmutableS3Reader>, 'get'> | null;
}

function empty(status: number, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers: { 'cache-control': 'private, no-store', ...headers } });
}

export async function downloadFile<Access>(request: Request, fileId: string, dependencies?: DownloadDependencies<Access>): Promise<Response> {
  if (!dependencies) return empty(503);
  if (request.method !== 'GET') return empty(405, { allow: 'GET' });
  try {
    const access = await dependencies.authorize(request, fileId);
    if (access == null) return empty(404);
    const generation = await dependencies.resolveGeneration(access, fileId);
    if (!generation) return empty(404);
    const { key, etag, sizeBytes, storageConfigId, evidenceRevision } = generation;
    if (!key || !storageConfigId || !evidenceRevision || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 ||
        typeof etag !== 'string' || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) return empty(404);
    const reader = dependencies.readerFor(storageConfigId);
    if (!reader) return empty(404);

    const ifMatch = request.headers.get('if-match');
    if (ifMatch !== null && ifMatch !== '*' && ifMatch !== etag) return empty(412);
    const requested = request.headers.get('range');
    const ifRange = request.headers.get('if-range');
    if (requested !== null && ifRange !== null && ifRange !== etag) return empty(412);
    let range: string | undefined;
    let contentRange: string | undefined;
    let length = sizeBytes;
    if (requested !== null) {
      const unsatisfied = () => empty(416, { 'content-range': `bytes */${sizeBytes}` });
      if (/^bytes=-0+$/i.test(requested)) return unsatisfied();
      try { range = validateRange(requested); } catch { return empty(400); }
      const [first, last] = range.slice(6).split('-');
      const start = first ? Number(first) : Math.max(0, sizeBytes - Number(last));
      if (start >= sizeBytes) return unsatisfied();
      const end = first && last ? Math.min(Number(last), sizeBytes - 1) : sizeBytes - 1;
      length = end - start + 1;
      contentRange = `bytes ${start}-${end}/${sizeBytes}`;
    }

    const result = await reader.get({ key, etag }, { range, maxResponseBytes: length, signal: request.signal });
    if (result.status !== 200 && result.status !== 206) return empty(404);
    if (result.status !== (range === undefined ? 200 : 206) || result.etag !== etag ||
        result.contentRange !== (contentRange ?? null) ||
        (result.contentLength === null ? range === undefined : Number(result.contentLength) !== length)) {
      void result.body.cancel().catch(() => {});
      return empty(404);
    }
    return new Response(result.body, { status: result.status, headers: {
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'content-disposition': 'attachment',
      'content-type': 'application/octet-stream',
      'content-length': String(length),
      etag,
      'x-content-type-options': 'nosniff',
      ...(contentRange === undefined ? {} : { 'content-range': contentRange })
    } });
  } catch {
    return empty(404);
  }
}
