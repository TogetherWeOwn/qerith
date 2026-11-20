// Imported only by the disposable browser Worker wrapper. Never forwards outbound fetches.
import { wireUploadStorage } from '../src/lib/server/storage-runtime.ts';
const endpoint = 'https://storage.example.test', bucket = 'drive-fixture', epoch = 'browser-fixture';
const region = 'test', accessKeyId = 'fixture-key', secretAccessKey = 'synthetic-secret';
const partTag = '"fixture-part"', etag = '"fixture-object"';
const uploads = new Map(), objects = new Map();
let calls = 0, shortNext = false;
export const storageCalls = () => calls;
export const truncateNextDownload = () => { shortNext = true; };
export const bindings = {
  DRIVE_S3_ENDPOINT: endpoint, DRIVE_S3_BUCKET: bucket, DRIVE_S3_REGION: region,
  DRIVE_S3_ACCESS_KEY_ID: accessKeyId, DRIVE_S3_SECRET_ACCESS_KEY: secretAccessKey,
  DRIVE_S3_STORAGE_EPOCH: epoch,
  DRIVE_S3_QUALIFICATION: JSON.stringify({ version: 1, storageConfigId: JSON.stringify([endpoint, bucket, epoch]),
    region, sourceSha: '0'.repeat(40), runId: '1', runAttempt: 1, completionTimeoutMs: 5000 }),
};
// Allocation still consumes the structured bindings; derive them from the same fixture identity.
const { DRIVE_UPLOAD_S3, DRIVE_UPLOAD_EPOCH, DRIVE_UPLOAD_VERIFIER } = wireUploadStorage(bindings, storageFetch);
export const storage = { ...bindings, DRIVE_UPLOAD_S3, DRIVE_UPLOAD_EPOCH, DRIVE_UPLOAD_VERIFIER };

export async function storageFetch(request) {
  calls++;
  const url = new URL(request.url), prefix = `/${bucket}/`;
  if (url.origin !== endpoint || !url.pathname.startsWith(prefix)) throw new Error('Unexpected fixture fetch');
  const key = url.pathname.slice(prefix.length), query = url.searchParams;
  if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('Unexpected fixture object key');
  const upload = uploads.get(key);
  if (request.method === 'POST' && query.has('uploads') && !upload && !objects.has(key)) {
    const id = crypto.randomUUID();
    uploads.set(key, { id });
    return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }
  if (upload && query.get('uploadId') === upload.id) {
    if (request.method === 'PUT' && query.get('partNumber') === '1' && !upload.bytes) {
      upload.bytes = await request.arrayBuffer();
      return new Response(null, { headers: { etag: partTag } });
    }
    if (request.method === 'GET' && upload.bytes) {
      return new Response(`<ListPartsResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${upload.id}</UploadId>
        <IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><ETag>${partTag}</ETag>
        <Size>${upload.bytes.byteLength}</Size></Part></ListPartsResult>`);
    }
    if (request.method === 'POST' && upload.bytes && (await request.text()).includes(`<ETag>${partTag}</ETag>`)) {
      uploads.delete(key);
      objects.set(key, upload.bytes);
      return new Response(`<CompleteMultipartUploadResult><ETag>${etag}</ETag></CompleteMultipartUploadResult>`);
    }
  }
  const bytes = objects.get(key);
  if (bytes && !url.search && request.headers.get('if-match') === etag && ['HEAD', 'GET'].includes(request.method)) {
    const range = request.headers.get('range');
    if (range !== null) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (!match || request.method !== 'GET') throw new Error('Unexpected fixture range');
      const [, first, last] = match, start = Number(first), end = Number(last);
      if (start > end || end >= bytes.byteLength) throw new Error('Unexpected fixture range bounds');
      const part = bytes.slice(start, end + 1);
      return new Response(part, { status: 206, headers: { etag, 'content-length': String(part.byteLength),
        'content-range': `bytes ${start}-${end}/${bytes.byteLength}` } });
    }
    const headers = { etag, 'content-length': String(bytes.byteLength) };
    if (request.method === 'GET' && shortNext) {
      shortNext = false;
      return new Response(new ReadableStream({ start(output) { output.close(); } }), { headers });
    }
    return new Response(request.method === 'GET' ? bytes.slice(0) : null, { headers });
  }
  throw new Error(`Unexpected fixture storage operation: ${request.method}`);
}
