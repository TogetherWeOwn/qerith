import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { uploadStorageEvidence } from '../src/lib/server/metadata/upload-storage-evidence';
import type { S3Config } from '../src/lib/server/s3/config';
import { createS3Listing } from '../src/lib/server/s3/listing';
import { createMultipartComplete } from '../src/lib/server/s3/multipart-complete';
import { MIN_PART_BYTES, type CompletedPart } from '../src/lib/server/s3/multipart-completion';
import { createMultipartCreate } from '../src/lib/server/s3/multipart-create';
import { createMultipartUpload } from '../src/lib/server/s3/multipart-upload';
import { createS3Objects } from '../src/lib/server/s3/objects';
import { createS3Transport } from '../src/lib/server/s3/transport';

const prefix = 'drive-qualification/storage-proof/';
const hexDigest = /^[a-f0-9]{64}$/;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const probeTimeoutMs = 60_000;
type Run = { sourceSha: string; runId: string; runAttempt: number };
type Scope = { identitySha256: string; policySha256: string };
type Failure = { phase: string; status?: number };

function requireEvidence(ok: unknown): asserts ok {
  if (!ok) throw new Error('Storage evidence mismatch');
}

export async function proveStorage(config: S3Config, epoch: string, run: Run, scope: Scope | null,
  send: typeof fetch = fetch, signal?: AbortSignal) {
  const evidence = { version: 1, ...run, passed: false, failures: [] as Failure[],
    scope: null as Scope | null, cleanup: 'not-started', pages: 0,
    parts: [] as { partNumber: number; size: number; etagSha256: string }[],
    completionMs: null as number | null, completionTimeoutMs: null as number | null,
    timeoutRationale: 'Twice the observed sign-through-body time, plus one second, rounded up to a second',
    generation: null as { etagSha256: string; bytes: number } | null,
    fullBytes: 0, rangeBytes: 0 };
  let phase = 'configuration';
  let status: number | undefined;
  function step(name: string) { phase = name; status = undefined; }
  function fail() { evidence.failures.push({ phase, ...(status !== undefined && { status }) }); }
  try {
    requireEvidence(/^[a-f0-9]{40}$/.test(run.sourceSha) && /^[1-9][0-9]{0,19}$/.test(run.runId) &&
      Number.isSafeInteger(run.runAttempt) && run.runAttempt > 0);
    const { settings, storageConfigId } = uploadStorageEvidence(config, epoch);
    step('reviewed-writer-scope');
    const identitySha256 = sha256(JSON.stringify([storageConfigId, settings.region, settings.accessKeyId]));
    requireEvidence(scope && scope.identitySha256 === identitySha256 && hexDigest.test(scope.policySha256));
    evidence.scope = { identitySha256, policySha256: scope.policySha256 };

    const runPrefix = `${prefix}${run.runId}/${run.runAttempt}/`;
    const key = `${runPrefix}fixture`;
    const observe: typeof fetch = async (...args) => {
      const response = await send(...args);
      status = response.status;
      return response;
    };
    const options = { fetch: observe, timeoutMs: 10_000 };
    const listing = createS3Listing(settings, options);
    const request = createS3Transport(settings, options);
    const objects = createS3Objects(settings, options);
    const active = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]);
    step('initial-head');
    requireEvidence((await objects.head(key, { signal: active })).status === 404);

    const fixture = Buffer.alloc(MIN_PART_BYTES + 257, 0x35);
    fixture.fill(0x9a, MIN_PART_BYTES);
    let uploadId: string | undefined;
    let completed = false;
    try {
      step('create-multipart');
      ({ uploadId } = await createMultipartCreate(settings, options)(key, active));
      const upload = createMultipartUpload(settings, options);
      const manifest: CompletedPart[] = [];
      step('upload-part');
      for (const bytes of [fixture.subarray(0, MIN_PART_BYTES), fixture.subarray(MIN_PART_BYTES)]) {
        manifest.push(await upload(key, uploadId, manifest.length + 1, bytes, active));
      }

      step('list-parts');
      let marker: number | undefined;
      for (let i = 0; i < manifest.length; i++) {
        const page = await listing.parts(key, uploadId, { partNumberMarker: marker, maxParts: 1, signal: active });
        evidence.pages++;
        const part = page.parts[0], ack = manifest[i];
        requireEvidence(page.parts.length === 1 && part.partNumber === ack.partNumber &&
          part.etag === ack.etag && part.size === ack.size);
        evidence.parts.push({ partNumber: part.partNumber, size: part.size, etagSha256: sha256(part.etag) });
        marker = page.nextPartNumberMarker;
        requireEvidence(marker === (i < manifest.length - 1 ? part.partNumber : undefined));
      }

      step('complete-multipart');
      const complete = createMultipartComplete(settings, { fetch: observe, timeoutMs: probeTimeoutMs });
      const start = performance.now();
      const result = await complete(key, uploadId, manifest, active).finally(() => {
        // The Worker transport resolves only after consuming the bounded response body.
        evidence.completionMs = Math.ceil(performance.now() - start);
      });
      completed = true;
      const budget = Math.ceil((2 * evidence.completionMs! + 1000) / 1000) * 1000;
      requireEvidence(budget <= probeTimeoutMs);
      evidence.completionTimeoutMs = budget;

      step('verify-head');
      const head = await objects.head(key, { ifMatch: result.etag, signal: active });
      requireEvidence(head.status === 200 && head.etag === result.etag && head.contentLength === String(fixture.length));
      evidence.generation = { etagSha256: sha256(result.etag), bytes: fixture.length };
      for (const range of [undefined, `bytes=${MIN_PART_BYTES - 2}-${MIN_PART_BYTES + 1}`]) {
        step(range ? 'verify-range-get' : 'verify-full-get');
        const expected = range ? fixture.subarray(MIN_PART_BYTES - 2, MIN_PART_BYTES + 2) : fixture;
        const get = await request({ method: 'GET', key, headers: { 'if-match': result.etag, ...(range && { range }) },
          maxResponseBytes: expected.length, signal: active });
        requireEvidence(get.status === (range ? 206 : 200) && get.headers.get('etag') === result.etag &&
          get.headers.get('content-length') === String(expected.length) && !get.headers.has('content-encoding') &&
          get.headers.get('content-range') === (range ? `bytes ${MIN_PART_BYTES - 2}-${MIN_PART_BYTES + 1}/${fixture.length}` : null) &&
          expected.equals(get.body));
        if (range) evidence.rangeBytes = get.body.length;
        else evidence.fullBytes = get.body.length;
      }
    } catch { fail(); }
    finally {
      // Never retry an ambiguous completion. Reconcile only the exact synthetic key;
      // the reviewed provider lifecycle is the fallback if the runner is killed.
      evidence.cleanup = 'unverified';
      const cleanup = AbortSignal.timeout(45_000);
      const before = evidence.failures.length;
      try {
        const abort = async (id: string) => {
          step('cleanup-abort-multipart');
          const response = await request({ method: 'DELETE', key, query: { uploadId: id }, maxResponseBytes: 8192, signal: cleanup });
          requireEvidence(response.status === 204 || response.status === 404);
        };
        if (uploadId && !completed) await abort(uploadId);
        step('cleanup-list-multipart');
        const pending = await listing.uploads({ prefix: runPrefix, signal: cleanup });
        requireEvidence(!pending.nextKeyMarker && pending.uploads.length <= 1 && pending.uploads.every((item) => item.key === key));
        if (pending.uploads.length) {
          await abort(pending.uploads[0].uploadId);
          step('cleanup-list-multipart');
          const after = await listing.uploads({ prefix: runPrefix, signal: cleanup });
          requireEvidence(!after.nextKeyMarker && !after.uploads.length);
        }
      } catch { fail(); }
      try {
        step('cleanup-head');
        const head = await request({ method: 'HEAD', key, maxResponseBytes: 0, signal: cleanup });
        requireEvidence(head.status === 200 || head.status === 404);
        if (head.status === 200) {
          step('cleanup-delete-object');
          const versionId = head.headers.get('x-amz-version-id');
          const result = await request({ method: 'DELETE', key, query: versionId ? { versionId } : undefined,
            maxResponseBytes: 8192, signal: cleanup });
          requireEvidence(result.status === 204);
          step('cleanup-head');
          requireEvidence((await objects.head(key, { signal: cleanup })).status === 404);
        }
      } catch { fail(); }
      if (evidence.failures.length === before) evidence.cleanup = 'verified';
    }
    evidence.passed = !active.aborted && evidence.failures.length === 0 && evidence.cleanup === 'verified';
  } catch { fail(); }
  return evidence;
}

async function main() {
  const env = process.env;
  const scope = { identitySha256: env.PROOF_IDENTITY_SHA256 ?? '', policySha256: env.PROOF_POLICY_SHA256 ?? '' };
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort());
  process.once('SIGINT', () => stop.abort());
  const result = await proveStorage({ endpoint: env.QERITH_S3_ENDPOINT ?? '', bucket: env.QERITH_S3_BUCKET ?? '',
    region: env.QERITH_S3_REGION ?? '', accessKeyId: env.QERITH_S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.QERITH_S3_SECRET_ACCESS_KEY ?? '' }, env.QERITH_S3_STORAGE_EPOCH ?? '', {
    sourceSha: env.GITHUB_SHA ?? '', runId: env.GITHUB_RUN_ID ?? '', runAttempt: Number(env.GITHUB_RUN_ATTEMPT)
  }, scope, fetch, stop.signal);
  await writeFile(`${env.RUNNER_TEMP}/drive-staging-storage-proof.json`, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (!result.passed) process.exitCode = 1;
}

if (import.meta.main) main().catch(() => {
  process.exitCode = 1;
  console.error('Could not write staging storage proof');
});
