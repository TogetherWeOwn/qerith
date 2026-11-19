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

// Passing the native readable to Response lets Workers set the wire length.
// Pipe cancellation and source errors travel in both directions without buffering the object.
async function fixedLength(body: ReadableStream<Uint8Array>, length: number) {
  if (length === 0) {
    const reader = body.getReader();
    try {
      if (!(await reader.read()).done) throw new Error('Unexpected download bytes');
      return new Uint8Array(0);
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const stream = new FixedLengthStream(length);
  // A client may consider the advertised length complete even before the
  // stream closes. Send the last byte only after upstream EOF is confirmed.
  let remaining = length;
  let lastByte: Uint8Array | undefined;
  const verified = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, output) {
      remaining -= chunk.byteLength;
      if (remaining === 0) {
        lastByte = chunk.slice(-1);
        if (chunk.byteLength > 1) output.enqueue(chunk.subarray(0, -1));
      } else output.enqueue(chunk);
    },
    flush(output) {
      if (!lastByte) throw new Error('Incomplete download');
      output.enqueue(lastByte);
    }
  }));
  void verified.pipeTo(stream.writable).catch(() => {});
  return stream.readable;
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
