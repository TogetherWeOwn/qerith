import { downloadFile } from './download';
import { createPublishedReadAccess } from './metadata/read-access';
import { createImmutableS3Reader, createS3Objects } from './s3/objects';

export interface DownloadEnv {
  DB?: Parameters<typeof createPublishedReadAccess>[0];
  DRIVE_S3_ENDPOINT?: string;
  DRIVE_S3_BUCKET?: string;
  DRIVE_S3_REGION?: string;
  DRIVE_S3_ACCESS_KEY_ID?: string;
  DRIVE_S3_SECRET_ACCESS_KEY?: string;
  DRIVE_S3_STORAGE_EPOCH?: string;
}

const timeoutMs = 15_000;
const streamBudget = { idleMs: 30_000, totalMs: 4 * 60 * 60 * 1000 };

export function downloadStorage(env: DownloadEnv) {
  const { DB, DRIVE_S3_ENDPOINT: endpoint, DRIVE_S3_BUCKET: bucket, DRIVE_S3_REGION: region,
    DRIVE_S3_ACCESS_KEY_ID: accessKeyId, DRIVE_S3_SECRET_ACCESS_KEY: secretAccessKey,
    DRIVE_S3_STORAGE_EPOCH: epoch } = env;
  if (!DB || !endpoint || !bucket || !region || !accessKeyId || !secretAccessKey || !epoch) return null;
  try {
    const config = { endpoint, bucket, region, accessKeyId, secretAccessKey };
    return { ...createPublishedReadAccess(DB, epoch, config), config };
  } catch { return null; }
}

// The immutable reader validates the byte count at EOF. Check that there are
// deliverable bytes before committing headers, and hold the last byte until EOF.
async function fixedLength(body: ReadableStream<Uint8Array>, length: number) {
  const reader = body.getReader();
  const cancel = () => reader.cancel().catch(() => {});
  try {
    const first = await reader.read();
    if (first.done) return new Uint8Array(0);
    if (length === 1) {
      if (!(await reader.read()).done) throw new Error('Unexpected download bytes');
      return first.value.slice();
    }
    // Only the native readable lets Workers set the response's wire length.
    const stream = new FixedLengthStream(length);
    const writer = stream.writable.getWriter();
    void writer.closed.catch(cancel); // client cancellation, including during a pending upstream read
    void (async () => {
      let remaining = length;
      try {
        for (let part: ReadableStreamReadResult<Uint8Array> = first; !part.done; part = await reader.read()) {
          const bytes = part.value;
          remaining -= bytes.length;
          if (remaining === 0) {
            if (bytes.length > 1) await writer.write(bytes.subarray(0, -1));
            if (!(await reader.read()).done) throw new Error('Unexpected download bytes');
            await writer.write(bytes.subarray(-1));
            break;
          }
          await writer.write(bytes);
        }
        await writer.close();
      } catch (error) {
        void cancel();
        void writer.abort(error).catch(() => {});
      }
    })();
    return stream.readable;
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
  return downloadFile(request, id, {
    authorize: async () => token,
    resolveGeneration,
    readerFor: (id) => id === storageConfigId ? reader : null,
    onReadError,
    fixedLength
  });
}
