import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtempDisposable, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'; // Locked by Wrangler.
import { unstable_splitSqlQuery } from 'wrangler';
import { createS3Listing } from '../src/lib/server/s3/listing.ts';
import { listingText, parseListingXml } from '../src/lib/server/s3/listing-xml.ts';
import { createMultipartCreate } from '../src/lib/server/s3/multipart-create.ts';
import { createMultipartUpload } from '../src/lib/server/s3/multipart-upload.ts';
import { firstReleaseBuildDigest } from './first-release-build-digest.mjs';
import { exerciseFirstReleaseCases } from './first-release-smoke-cases.mjs';
import { writeSmokeReceipt } from './first-release-smoke-evidence.mjs';
import { minioRelease, verifyLocalObjectExpiry, withLocalMinio } from './first-release-smoke-minio.mjs';
import { checkedSmokeDispatch, smokeWorkerSecrets, smokeWorkerVars } from './first-release-smoke-target.mjs';
import { cleanR2Prefix, readQualificationR2Prefix } from './staging-qualification-cleanup.mjs';

async function exerciseLocalWorker(scope, storage, setWriterActive) {
  const origin = 'https://drive-smoke.example.test';
  const version = randomUUID();
  const bootstrapToken = randomBytes(32).toString('base64url');
  const smokeToken = randomBytes(32).toString('base64url');
  const now = Date.now();
  const config = JSON.parse(await readFile('wrangler.build.jsonc', 'utf8'));
  const worker = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.NONE),
    modules: [{ type: 'ESModule', path: resolve('.svelte-kit/first-release-package/_worker.js') }],
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    assets: { ...config.assets, directory: resolve(config.assets.directory), routerConfig: { has_user_worker: true } },
    d1Databases: { DB: randomUUID() },
    bindings: { ...smokeWorkerVars(scope, origin, now),
      ...smokeWorkerSecrets(scope, storage.settings, { bootstrapToken, smokeToken, now }),
      DRIVE_QUALIFICATION_VERSION: { id: version } },
    outboundService(request) {
      const path = new URL(request.url).pathname;
      if (!path.startsWith(`/${storage.settings.bucket}/${scope.prefix}`) || !request.headers.has('authorization')) {
        throw new Error('Unexpected Worker storage request');
      }
      return storage.send(request);
    },
  }));
  setWriterActive(true);
  try {
    const db = await worker.getD1Database('DB');
    for (const file of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
      const migration = await readFile(join('migrations', file), 'utf8');
      await db.batch(unstable_splitSqlQuery(migration).map(sql => db.prepare(sql)));
    }
    const request = (url, init) => {
      if (new URL(url).origin !== origin) throw new Error('Unexpected local Worker request');
      return worker.dispatchFetch(url, { ...init, redirect: 'manual',
        headers: { ...init.headers, 'x-drive-smoke-token': smokeToken } });
    };
    const cases = await exerciseFirstReleaseCases({ ...scope, origin, version }, bootstrapToken,
      AbortSignal.timeout(4 * 60_000), request);
    return { workerVersion: version, cases };
  } finally {
    await worker.dispose();
    setWriterActive(false);
  }
}

async function exerciseLocalStorage(scope, storage, markPhase) {
  const { settings, options, request } = storage;
  const list = createS3Listing(settings, options);
  // MinIO can omit uploads for a partial-prefix query. The bucket belongs to
  // this attempt, so validate the full listings and refuse every out-of-scope key.
  const listing = {
    objects: ({ signal }) => list.objects({ signal, verifyScope: true }),
    uploads: ({ signal }) => list.uploads({ signal, verifyScope: true }),
  };
  const inspect = signal => readQualificationR2Prefix(scope.prefix, signal, listing);
  const key = `${scope.prefix}incomplete-abort-fixture`;
  const setup = AbortSignal.timeout(30_000);
  const before = await inspect(setup);
  if (before.keys.length || before.uploads.length) throw new Error('Disposable bucket must be empty');
  let uploadId, abortConfirmed = false, writerActive = false, outcome;
  try {
    await verifyLocalObjectExpiry(scope.prefix, request);
    ({ uploadId } = await createMultipartCreate(settings, options)(key, setup));
    await createMultipartUpload(settings, options)(key, uploadId, 1, randomBytes(257), setup);
    const { parts, nextPartNumberMarker } = await list.parts(key, uploadId, { signal: setup });
    if (parts.length !== 1 || parts[0].partNumber !== 1 || parts[0].size !== 257 || nextPartNumberMarker !== undefined) {
      throw new Error('Incomplete upload fixture unverified');
    }
    markPhase('packaged Worker, local D1 migrations and eight cases');
    outcome = await exerciseLocalWorker(scope, storage, active => { writerActive = active; });
  } finally {
    const previousPhase = markPhase('explicit multipart abort and empty bucket cleanup');
    if (writerActive) throw new Error('Local Worker shutdown unverified');
    const signal = AbortSignal.timeout(60_000);
    await cleanR2Prefix(scope.prefix, signal, { listing, async request(operation) {
      const response = await request(operation);
      if (uploadId && operation.key === key && operation.query?.uploadId === uploadId && response.status === 204) {
        abortConfirmed = true;
      }
      return response;
    } });
    if (outcome) {
      const after = await request({ method: 'GET', key, query: { uploadId }, maxResponseBytes: 8192, signal });
      if (!abortConfirmed || after.status !== 404 || listingText(parseListingXml(after.body, 'Error'), 'Code') !== 'NoSuchUpload') {
        throw new Error('Incomplete upload abort unverified');
      }
    }
    markPhase(previousPhase);
  }
  return outcome;
}

let phase = 'protected dispatch and package identity';
function markPhase(step) {
  const previous = phase;
  phase = step;
  return previous;
}
try {
  const env = process.env;
  const dispatch = checkedSmokeDispatch(env);
  const runPath = join(env.RUNNER_TEMP, `drive-first-release-${dispatch.runId}-${dispatch.runAttempt}`);
  await mkdir(runPath, { mode: 0o700 });
  const scope = { ...dispatch, buildDigest: await firstReleaseBuildDigest() };
  const outcome = await (async () => {
    await using fixture = await mkdtempDisposable(join(env.RUNNER_TEMP, 'drive-first-release-local-'));
    phase = 'pinned MinIO startup, private bucket and synthetic storage fixtures';
    return await withLocalMinio(fixture.path, 'qerith-drive-smoke', storage => exerciseLocalStorage(scope, storage, markPhase));
  })();
  phase = 'cleaned fixture and unchanged package evidence';
  if (await firstReleaseBuildDigest() !== scope.buildDigest) throw new Error('Package digest changed');
  await writeSmokeReceipt(runPath, scope, outcome, 'github-hosted-local', {
    minioRelease, objectExpiryRule: 'pass', incompleteUploadAbort: 'pass', bucketEmpty: 'pass',
  });
  console.log(`Drive staging smoke passed in github-hosted-local at ${scope.sha}. Build digest ${scope.buildDigest}.`);
} catch (error) {
  const cases = /^Drive first-release smoke failed during [a-z -]+(?:: Expected private HTTP \d+, received \d+)?\.$/;
  console.error(cases.test(error?.message) ? error.message : `Drive local staging smoke failed during ${phase}.`);
  process.exitCode = 1;
}
