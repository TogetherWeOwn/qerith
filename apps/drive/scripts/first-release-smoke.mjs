import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createS3Listing } from '../src/lib/server/s3/listing.ts';
import { createS3Transport } from '../src/lib/server/s3/transport.ts';
import { firstReleaseBuildDigest } from './first-release-build-digest.mjs';
import { exerciseFirstReleaseCases } from './first-release-smoke-cases.mjs';
import { versionIdPattern, writeSmokeReceipt } from './first-release-smoke-evidence.mjs';
import { checkedSmokeDispatch, scopedSmokeTarget, smokeMigrationArgs, smokeProvider, smokeWorkerConfig,
  smokeWorkerSecrets } from './first-release-smoke-target.mjs';
import { cleanR2Prefix, readQualificationR2Prefix } from './staging-qualification-cleanup.mjs';

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
  const bootstrapToken = randomBytes(32).toString('base64url');
  const smokeToken = randomBytes(32).toString('base64url');
  const settings = smokeWorkerConfig(config, scope, target, Date.now());
  await writeFile(configPath, JSON.stringify(settings), { mode: 0o600 });
  wrangler([...smokeMigrationArgs(configPath), '--remote'], target, 120_000);
  await writeFile(secretsPath, JSON.stringify(smokeWorkerSecrets(scope, target.s3,
    { bootstrapToken, smokeToken, now: Date.now() })), { mode: 0o600 });
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
  const scope = checkedSmokeDispatch(env);
  if (mode !== 'exercise' && mode !== 'cleanup') throw new Error('Invalid smoke execution context');
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
  await writeSmokeReceipt(runPath, { ...scope, buildDigest }, outcome, 'cloudflare');
}

try {
  await run(process.argv[2], process.env);
} catch (error) {
  // Surface only static, bounded messages from our own guards and probes.
  const safe = /^(?:Invalid protected smoke dispatch|Invalid smoke execution context|Smoke Worker |Smoke attempt |Scoped Cloudflare API |Disposable D1 |Disposable R2 |Disposable fixture cleanup |R2 attempt expiry |R2 expiry rules |Missing or invalid scoped smoke target |Smoke cleanup target |Smoke case evidence |Drive first-release smoke failed during |Cannot verify cleanup ownership)/;
  console.error(safe.test(error?.message) ? error.message : 'Drive first-release smoke failed without verified evidence.');
  process.exitCode = 1;
}
