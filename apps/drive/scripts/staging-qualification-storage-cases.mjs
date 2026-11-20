import { assertQualificationJob, qualificationPrefix } from './staging-qualification.mjs';
import { readQualificationR2Binding } from './staging-qualification-storage.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';

const unverified = () => new Error('Qualification S3 cases are unverified.');

// Exercise one synthetic key. Cleanup is the lifecycle's responsibility even
// when a create or complete response is lost; neither operation is retried.
export async function exerciseQualificationStorage(context, signal, { create, upload, listParts, complete, head, request, partBytes }) {
  try {
    const prefix = qualificationPrefix(context);
    if (context.prefix !== prefix) throw unverified();
    const key = `${prefix}provider-multipart-fixture`;
    return await runQualificationPhase(async (_, active) => {
      if ((await head(key, { signal: active })).status !== 404) throw unverified();
      const bytes = Buffer.alloc(partBytes + 257, 0x35);
      bytes.fill(0x9a, partBytes);
      const start = partBytes - 2, end = partBytes + 1;
      // Uniform fills alone would let a same-length read from the wrong offsets pass.
      bytes.set([0x12, 0x34, 0x56, 0x78], start);
      const { uploadId } = await create(key, active);
      const verifyPart = async (expected, partNumber, size, marker, nextMarker) => {
        const { parts, nextPartNumberMarker } = await listParts(key, uploadId, { partNumberMarker: marker, maxParts: 1, signal: active });
        const part = parts[0];
        if (parts.length !== 1 || part.partNumber !== partNumber || expected.partNumber !== partNumber ||
            part.etag !== expected.etag || part.size !== size || nextPartNumberMarker !== nextMarker) throw unverified();
      };
      const initial = await upload(key, uploadId, 1, Buffer.alloc(partBytes, 0x71), active);
      await verifyPart(initial, 1, partBytes);
      // Replace the verified seed and repeat the same part write with identical bytes.
      const firstBytes = bytes.subarray(0, partBytes);
      const first = await upload(key, uploadId, 1, firstBytes, active);
      const retry = await upload(key, uploadId, 1, firstBytes, active);
      if (initial.etag === first.etag || retry.etag !== first.etag) throw unverified();
      const last = await upload(key, uploadId, 2, bytes.subarray(partBytes), active);
      const manifest = [retry, last];
      await verifyPart(retry, 1, partBytes, undefined, 1);
      await verifyPart(last, 2, 257, 1);
      const { etag } = await complete(key, uploadId, manifest, active);
      const stored = await head(key, { ifMatch: etag, signal: active });
      if (stored.status !== 200 || stored.etag !== etag || stored.contentLength !== String(bytes.length)) throw unverified();
      for (const range of [false, true]) {
        const expected = range ? bytes.subarray(start, end + 1) : bytes;
        const get = await request({ method: 'GET', key, signal: active, maxResponseBytes: expected.length,
          headers: { 'if-match': etag, ...(range && { range: `bytes=${start}-${end}` }) } });
        if (get.status !== (range ? 206 : 200) || get.headers.get('etag') !== etag ||
            get.headers.get('content-length') !== String(expected.length) || get.headers.has('content-encoding') ||
            get.headers.get('content-range') !== (range ? `bytes ${start}-${end}/${bytes.length}` : null) ||
            !expected.equals(get.body)) throw unverified();
      }
      return { 's3-multipart': 'pass', 's3-range': 'pass', 's3-retry': 'pass', 's3-persistence': 'pass' };
    }, null, signal, 120_000);
  } catch {
    throw unverified();
  }
}

// Unwired: the protected caller must verify expiry, serialize staging and
// establish post-case writer quiescence before prefix cleanup.
export async function createQualificationStorageCases(env, cwd, { send = fetch } = {}) {
  const identity = assertQualificationJob(env, cwd);
  const { settings, completionTimeoutMs } = await readQualificationR2Binding(env, cwd, identity.sha)
    .catch(() => { throw unverified(); });
  const [{ createMultipartCreate }, { createMultipartUpload }, { createS3Listing }, { createMultipartComplete },
    { createS3Objects }, { createS3Transport }, { MIN_PART_BYTES }] = await Promise.all([
    import('../src/lib/server/s3/multipart-create.ts'), import('../src/lib/server/s3/multipart-upload.ts'),
    import('../src/lib/server/s3/listing.ts'), import('../src/lib/server/s3/multipart-complete.ts'),
    import('../src/lib/server/s3/objects.ts'), import('../src/lib/server/s3/transport.ts'),
    import('../src/lib/server/s3/multipart-completion.ts'),
  ]);
  const options = { fetch: send, timeoutMs: 10_000 };
  const io = { create: createMultipartCreate(settings, options), upload: createMultipartUpload(settings, options),
    listParts: createS3Listing(settings, options).parts,
    complete: createMultipartComplete(settings, { ...options, timeoutMs: completionTimeoutMs }),
    head: createS3Objects(settings, options).head, request: createS3Transport(settings, options), partBytes: MIN_PART_BYTES };
  return (context, signal) => {
    if (context.sha !== identity.sha || context.runId !== identity.runId || context.attempt !== identity.attempt) throw unverified();
    return exerciseQualificationStorage(context, signal, io);
  };
}
