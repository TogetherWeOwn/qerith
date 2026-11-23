import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { firstReleaseUploadCapBytes } from '../src/lib/server/first-release-upload-limit.mjs';
import { createS3Listing } from '../src/lib/server/s3/listing.ts';
import { createS3Transport } from '../src/lib/server/s3/transport.ts';
import { firstReleaseBuildDigest } from './first-release-build-digest.mjs';
import { exerciseFirstReleaseCases } from './first-release-smoke-cases.mjs';
import { scopedSmokeTarget, smokeDispatch, smokeProvider } from './first-release-smoke-target.mjs';
import { cleanR2Prefix, readQualificationR2Prefix } from './staging-qualification-cleanup.mjs';

const cases = ['invite', 'uninvitedDenial', 'share', 'revoke', 'multipartResume', 'byteIdenticalDownload',
  'overCapRefusal', 'permanentDeletionUnavailable'];
const versionIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const expiryMs = 12 * 60_000;
const completionTimeoutMs = 3000;

function wrangler(args, target, timeout, extraEnv) {
  try {
    // Wrangler diagnostics can contain binding details. Emit only the phase in our own error.
    execFileSync(resolve('node_modules/.bin/wrangler'), args, { stdio: 'ignore', timeout,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId, CLOUDFLARE_API_TOKEN: target.token,
        CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'none', ...extraEnv } });
  } catch {
    throw new Error(args[0] === 'd1' ? 'Disposable D1 migrations failed' : 'Smoke Worker publication failed');
  }
}

async function publish(scope, target) {
  const config = JSON.parse(await readFile('wrangler.build.jsonc', 'utf8'));
  await using temp = await mkdtempDisposable(join(process.env.RUNNER_TEMP, 'drive-first-release-'));
  const configPath = join(temp.path, 'wrangler.json');
  const outputPath = join(temp.path, 'wrangler-output.jsonl');
  const secretsPath = join(temp.path, 'secrets.json');
  const { endpoint, bucket, region, accessKeyId, secretAccessKey } = target.s3;
  const epoch = `smoke-${scope.runId}-${scope.runAttempt}`;
  const bootstrapToken = randomBytes(32).toString('base64url');
  const smokeToken = randomBytes(32).toString('base64url');
  await writeFile(configPath, JSON.stringify({
    ...config,
    name: scope.worker,
    main: resolve('.svelte-kit/first-release-package/_worker.js'),
    assets: { ...config.assets, directory: resolve(config.assets.directory) },
    workers_dev: true,
    preview_urls: false,
    upload_source_maps: false,
    d1_databases: [{ binding: 'DB', database_id: target.databaseId, database_name: target.databaseName,
      migrations_dir: resolve('migrations') }],
    version_metadata: { binding: 'DRIVE_QUALIFICATION_VERSION' },
    vars: {
      DRIVE_ORIGIN: target.origin,
      DRIVE_FIRST_RELEASE_ORIGIN: target.origin,
      DRIVE_STAGING_INVITE_ACCEPTANCE: '1',
      DRIVE_STAGING_READ_GRANTS: '1',
      DRIVE_STAGING_SHARED_LISTING: '1',
      DRIVE_OWNER_ENROLLMENT_RELEASE: scope.sha,
      DRIVE_QUALIFICATION_SHA: scope.sha,
      DRIVE_FIRST_RELEASE_BUILD_DIGEST: scope.buildDigest,
      DRIVE_QUALIFICATION_RUN_ID: scope.runId,
      DRIVE_QUALIFICATION_RUN_ATTEMPT: String(scope.runAttempt),
      DRIVE_QUALIFICATION_EXPIRES_AT: String(Date.now() + expiryMs),
    },
  }), { mode: 0o600 });
  wrangler(['d1', 'migrations', 'apply', target.databaseId, '--remote', '--config', configPath], target, 120_000);
  await writeFile(secretsPath, JSON.stringify({
    DRIVE_FIRST_RELEASE_SMOKE_TOKEN: smokeToken,
    DRIVE_OWNER_ENROLLMENT: `${scope.sha}:${Date.now() + 290_000}:${bootstrapToken}`,
    DRIVE_S3_ENDPOINT: endpoint,
    DRIVE_S3_BUCKET: bucket,
    DRIVE_S3_REGION: region,
    DRIVE_S3_ACCESS_KEY_ID: accessKeyId,
    DRIVE_S3_SECRET_ACCESS_KEY: secretAccessKey,
    DRIVE_S3_STORAGE_EPOCH: epoch,
    DRIVE_S3_QUALIFICATION: JSON.stringify({ version: 1, sourceSha: scope.sha, runId: scope.runId,
      runAttempt: scope.runAttempt, region, storageConfigId: JSON.stringify([endpoint, bucket, epoch]), completionTimeoutMs }),
  }), { mode: 0o600 });
  wrangler(['deploy', '--config', configPath, '--no-bundle', '--secrets-file', secretsPath], target, 120_000,
    { WRANGLER_OUTPUT_FILE_PATH: outputPath });
  const entries = (await readFile(outputPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const outputs = entries.filter(entry => entry.type === 'deploy');
  if (outputs.length !== 1 || outputs[0].worker_name !== scope.worker || !versionIdPattern.test(outputs[0].version_id)) {
    throw new Error('Smoke Worker deployment identity is unverified');
  }
  const request = (url, init) => {
    if (!url.startsWith(target.origin + '/')) throw new Error('Unexpected smoke request target');
    return fetch(url, { ...init, headers: { ...init.headers, 'x-drive-smoke-token': smokeToken } });
  };
  const probe = { ...scope, origin: target.origin, version: outputs[0].version_id };
  const outcome = await exerciseFirstReleaseCases(probe, bootstrapToken, AbortSignal.timeout(4 * 60_000), request);
  return { workerVersion: probe.version, cases: outcome };
}

async function run(mode, env) {
  const scope = smokeDispatch(env);
  if (execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).trim() !== scope.sha ||
      !env.RUNNER_TEMP || (mode !== 'exercise' && mode !== 'cleanup')) throw new Error('Invalid smoke execution context');
  const runPath = join(env.RUNNER_TEMP, `drive-first-release-${scope.runId}-${scope.runAttempt}`);
  const claimPath = join(runPath, 'claim.json');
  const successPath = join(runPath, 'cases.json');
  const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
  const maybeRead = async (path) => read(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const claim = await maybeRead(claimPath);
  if (mode === 'cleanup' && claim === null) return;
  const target = scopedSmokeTarget(env, scope, { cleanup: mode === 'cleanup' });
  const provider = smokeProvider(target, scope);
  const io = { listing: createS3Listing(target.s3, { timeoutMs: 8000, drainBufferedAbort: true }),
    request: createS3Transport(target.s3, { timeoutMs: 8000, drainBufferedAbort: true }) };
  const buildDigest = await firstReleaseBuildDigest();
  const identity = { ...scope, accountId: target.accountId, databaseId: target.databaseId, databaseName: target.databaseName,
    bucket: target.bucket, origin: target.origin, scopeEvidenceDigest: target.scopeEvidenceDigest, buildDigest };

  if (mode === 'exercise') {
    // All checks here are read-only. Only a fresh, authorized claim can pass into mutation.
    if (claim !== null) throw new Error('Smoke attempt already claimed its resources');
    await provider.preflight();
    const before = await readQualificationR2Prefix(scope.prefix, AbortSignal.timeout(20_000), io.listing);
    if (before.keys.length || before.uploads.length) throw new Error('Smoke attempt R2 prefix is occupied');
    await mkdir(runPath, { mode: 0o700 });
    await writeFile(claimPath, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
    const outcome = await publish({ ...scope, buildDigest }, target);
    await writeFile(successPath, JSON.stringify(outcome), { flag: 'wx', mode: 0o600 });
    return;
  }

  if (JSON.stringify(claim) !== JSON.stringify(identity)) throw new Error('Smoke cleanup target does not match the recorded claim');
  // Stop writers first. A reconciliation failure blocks receipt generation.
  await provider.stopWorker(buildDigest);
  const cleanup = await Promise.allSettled([
    cleanR2Prefix(scope.prefix, AbortSignal.timeout(55_000), io),
    provider.removeDb(),
  ]);
  if (cleanup[0].status !== 'fulfilled' || cleanup[1].status !== 'fulfilled') {
    throw new Error(`Disposable fixture cleanup unverified for ${cleanup.map(({ status }, i) =>
      status === 'rejected' ? ['R2 prefix', 'D1 database'][i] : null).filter(Boolean).join(' and ')}`);
  }
  const outcome = await maybeRead(successPath);
  if (outcome === null) return;
  if (!versionIdPattern.test(outcome.workerVersion) || Object.keys(outcome.cases).length !== cases.length ||
      !cases.every(name => outcome.cases[name] === 'pass')) throw new Error('Smoke case evidence is incomplete');
  const receipt = {
    version: 1, sourceSha: scope.sha, runId: scope.runId, runAttempt: scope.runAttempt,
    buildDigest, workerVersion: outcome.workerVersion, testedSizeCapBytes: firstReleaseUploadCapBytes,
    cases: { ...outcome.cases, cleanup: 'pass' },
  };
  await writeFile(join(runPath, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

try {
  await run(process.argv[2], process.env);
} catch (error) {
  // Surface only static, bounded messages from our own guards and probes.
  const safe = /^(?:Invalid protected smoke dispatch|Invalid smoke execution context|Smoke Worker |Smoke attempt |Scoped Cloudflare API |Disposable D1 |Disposable R2 |Disposable fixture cleanup |R2 attempt expiry |R2 expiry rules |Missing or invalid scoped smoke target |Smoke cleanup target |Smoke case evidence |Drive first-release smoke failed during |Cannot verify cleanup ownership)/;
  console.error(safe.test(error?.message) ? error.message : 'Drive first-release smoke failed without verified evidence.');
  process.exitCode = 1;
}
