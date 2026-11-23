import { downloadFile } from './download';
import { createPublishedReadAccess } from './metadata/read-access';
import { admitsStagingInvite, privateDriveOrigin, type DriveAuthEnv } from './request-auth';
import { createImmutableS3Reader, createS3Objects } from './s3/objects';
import { storageIdentity, type StorageBindings } from './storage-runtime';

export interface DownloadEnv extends StorageBindings, Pick<DriveAuthEnv, 'DRIVE_ORIGIN' | 'DRIVE_FIRST_RELEASE_ORIGIN' | 'DRIVE_STAGING_INVITE_ACCEPTANCE'> {
  DB?: Parameters<typeof createPublishedReadAccess>[0];
}

const timeoutMs = 15_000;
const streamBudget = { idleMs: 30_000, totalMs: 4 * 60 * 60 * 1000 };

export function downloadStorage(env: DownloadEnv, inviteMode: 'own-file' | 'grant-aware' = 'own-file') {
  const identity = storageIdentity(env);
  if (!env.DB || !identity) return null;
  const { settings: config, epoch } = identity;
  const mode = admitsStagingInvite(env) ? inviteMode : privateDriveOrigin(env) !== null;
  return { ...createPublishedReadAccess(env.DB, epoch, config, mode), config };
}

// The immutable reader validates the byte count at EOF. Check that there are
// deliverable bytes before committing headers, and hold the last byte until EOF.
async function fixedLength(body: ReadableStream<Uint8Array>, length: number, signal: AbortSignal) {
  const reader = body.getReader();
  const cancel = () => reader.cancel().catch(() => {});
  try {
    const first = await reader.read();
    // For one byte, verify EOF before handing off the response, not before a second write.
    if (length === 1 && !first.done && !(await reader.read()).done) throw new Error('Unexpected download bytes');
    signal.throwIfAborted();
    if (first.done) return new Uint8Array(0);
    // Keep the native wire length. At this compatibility date abort clears pending writes.
    const { readable, writable } = new FixedLengthStream(length);
    const writer = writable.getWriter();
    const fail = (error: unknown) => { void cancel(); void writer.abort(error).catch(() => {}); };
    const abort = () => fail(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void writer.closed.catch(cancel);
    void (async () => {
      let remaining = length;
      try {
        for (let part: ReadableStreamReadResult<Uint8Array> = first; !part.done; part = await reader.read()) {
          const bytes = part.value;
          remaining -= bytes.length;
          if (remaining === 0) {
            if (bytes.length > 1) await writer.write(bytes.subarray(0, -1));
            if (length > 1 && !(await reader.read()).done) throw new Error('Unexpected download bytes');
            signal.throwIfAborted();
            await writer.write(bytes.subarray(-1));
            break;
          }
          await writer.write(bytes);
        }
        await writer.close();
      } catch (error) { fail(error); }
      finally { signal.removeEventListener('abort', abort); }
    })();
    return readable;
  } catch (error) {
    void cancel();
    throw error;
  }
}

export async function publishedDownload(request: Request, id: string, token: string,
  env: DownloadEnv, onReadError: () => void, transport: typeof fetch = fetch) {
  const storage = downloadStorage(env, 'grant-aware');
  if (!storage) return downloadFile(request, id);
  const { config, storageConfigId, resolveGeneration } = storage;
  const staging = privateDriveOrigin(env) !== null;
  let generation: Awaited<ReturnType<typeof resolveGeneration>> = null;
  // Start before authorization and keep the same cutoff through storage and native delivery.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(streamBudget.totalMs)]);
  const resolveCurrent = async () => {
    if (!staging) return resolveGeneration(token, id);
    if (signal.aborted) return null;
    const lookup = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const stopped = Promise.withResolvers<null>();
    const abort = () => stopped.resolve(null);
    lookup.addEventListener('abort', abort, { once: true });
    try {
      const current = await Promise.race([resolveGeneration(token, id), stopped.promise]);
      return lookup.aborted ? null : current;
    } finally { lookup.removeEventListener('abort', abort); }
  };
  const stillAuthorized = async () => {
    const current = await resolveCurrent();
    return !signal.aborted && !!current && !!generation && current.evidenceRevision === generation.evidenceRevision &&
      current.key === generation.key && current.etag === generation.etag && current.sizeBytes === generation.sizeBytes &&
      current.name === generation.name;
  };
  let reader;
  try {
    reader = createImmutableS3Reader(createS3Objects(config, {
      fetch: transport, timeoutMs, streamBudget, beforeSend: staging ? stillAuthorized : undefined
    }));
  } catch { return downloadFile(request, id); }
  let readError = false;
  const response = await downloadFile(new Request(request, { signal }), id, {
    authorize: async () => token,
    resolveGeneration: async () => generation = await resolveCurrent(),
    readerFor: (id) => id === storageConfigId ? reader : null,
    onReadError: () => { readError = true; },
    fixedLength: (body, length) => fixedLength(body, length, signal)
  });
  // A retry notice also identifies a file, so suppress it if access was lost.
  if (staging && generation && (response.status !== 404 || readError) && !await stillAuthorized()) {
    void response.body?.cancel().catch(() => {});
    return new Response(null, { status: 404, headers: { 'cache-control': 'private, no-store' } });
  }
  if (readError) onReadError();
  return response;
}
