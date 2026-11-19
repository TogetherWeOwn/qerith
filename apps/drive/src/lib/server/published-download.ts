import { downloadFile } from './download';
import { createPublishedReadAccess } from './metadata/read-access';
import { createImmutableS3Reader, createS3Objects } from './s3/objects';
import { storageIdentity, type StorageBindings } from './storage-runtime';

export interface DownloadEnv extends StorageBindings {
  DB?: Parameters<typeof createPublishedReadAccess>[0];
}

const timeoutMs = 15_000;
const streamBudget = { idleMs: 30_000, totalMs: 4 * 60 * 60 * 1000 };

export function downloadStorage(env: DownloadEnv) {
  const identity = storageIdentity(env);
  if (!env.DB || !identity) return null;
  const { settings: config, epoch } = identity;
  return { ...createPublishedReadAccess(env.DB, epoch, config), config };
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
  const storage = downloadStorage(env);
  if (!storage) return downloadFile(request, id);
  const { config, storageConfigId, resolveGeneration } = storage;
  let reader;
  try {
    reader = createImmutableS3Reader(createS3Objects(config, { fetch: transport, timeoutMs, streamBudget }));
  } catch { return downloadFile(request, id); }
  // Start before authorization and keep the same cutoff through storage and native delivery.
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(streamBudget.totalMs)]);
  return downloadFile(new Request(request, { signal }), id, {
    authorize: async () => token,
    resolveGeneration,
    readerFor: (id) => id === storageConfigId ? reader : null,
    onReadError,
    fixedLength: (body, length) => fixedLength(body, length, signal)
  });
}
