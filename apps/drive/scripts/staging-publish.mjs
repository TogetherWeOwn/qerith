import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempDisposableSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const configPath = 'wrangler.staging.json';
const entryPath = '.svelte-kit/cloudflare/_worker.js';
const assetsPath = '.svelte-kit/cloudflare';

function requireContained(root, relative, type) {
  const actual = realpathSync(resolve(root, relative));
  if (!actual.startsWith(`${realpathSync(root)}${sep}`) || !statSync(actual)[type]()) {
    throw new Error(`invalid staging ${relative}`);
  }
}

export function validateStagingTarget(root, accountId) {
  if (accountId !== '209cf7dd678adfb683947dd7874d05af') {
    throw new Error('invalid staging Cloudflare account');
  }
  requireContained(root, configPath, 'isFile');
  requireContained(root, entryPath, 'isFile');
  requireContained(root, assetsPath, 'isDirectory');
  const config = JSON.parse(readFileSync(resolve(root, configPath), 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).sort().join(',') !== 'assets,compatibility_date,compatibility_flags,d1_databases,main,name' ||
      config.compatibility_date !== '2026-07-30' ||
      !Array.isArray(config.compatibility_flags) || config.compatibility_flags.length !== 2 ||
      config.compatibility_flags[0] !== 'nodejs_compat' || config.compatibility_flags[1] !== 'enable_request_signal' ||
      !Array.isArray(config.d1_databases) || config.d1_databases.length !== 1 ||
      !config.d1_databases[0] || typeof config.d1_databases[0] !== 'object' ||
      Object.keys(config.d1_databases[0]).sort().join(',') !== 'binding,database_id,database_name,migrations_dir' ||
      config.d1_databases[0].binding !== 'DB' ||
      config.d1_databases[0].database_name !== 'qerith-drive-staging' ||
      config.d1_databases[0].database_id !== '87ac8041-ad2d-4650-b0d7-05bb78846f60' ||
      config.d1_databases[0].migrations_dir !== 'migrations' ||
      !config.assets || typeof config.assets !== 'object' || Array.isArray(config.assets) ||
      Object.keys(config.assets).sort().join(',') !== 'binding,directory,run_worker_first' ||
      config.name !== 'qerith-drive-staging' || config.main !== entryPath ||
      config.assets.directory !== assetsPath || config.assets.binding !== 'ASSETS' ||
      config.assets.run_worker_first !== true) {
    throw new Error('invalid staging Worker configuration');
  }
  requireContained(root, 'node_modules/.bin/wrangler', 'isFile');
  return config;
}

const storageKeys = ['ENDPOINT', 'BUCKET', 'REGION', 'STORAGE_EPOCH', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'];

async function stagingStorage(env, receipt) {
  const names = storageKeys.map(key => `QERITH_S3_${key}`);
  const missing = names.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`missing staging storage settings: ${missing.join(', ')}`);
  const [endpoint, bucket, region, epoch, accessKeyId, secretAccessKey] = names.map(name => env[name]);
  const { validateConfig } = await import('../src/lib/server/s3/config.ts');
  const settings = validateConfig({ endpoint, bucket, region, accessKeyId, secretAccessKey });
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(epoch) || settings.endpoint.length > 2048) {
    throw new Error('invalid staging storage identity');
  }
  const storageConfigId = JSON.stringify([settings.endpoint, bucket, epoch]);
  const identitySha256 = createHash('sha256').update(JSON.stringify([storageConfigId, region, accessKeyId])).digest('hex');
  const { version, sourceSha, runId, runAttempt, completionTimeoutMs } = receipt ?? {};
  if (version !== 1 || receipt.passed !== true || !Array.isArray(receipt.failures) || receipt.failures.length !== 0 ||
      receipt.cleanup !== 'verified' ||
      receipt.scope?.identitySha256 !== identitySha256 || !/^[0-9a-f]{64}$/.test(receipt.scope.policySha256 ?? '') ||
      typeof sourceSha !== 'string' || !/^[0-9a-f]{40}$/.test(sourceSha) ||
      typeof runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(runId) || !Number.isSafeInteger(runAttempt) || runAttempt < 1 ||
      !Number.isSafeInteger(completionTimeoutMs) || completionTimeoutMs < 1 || completionTimeoutMs > 60_000) {
    throw new Error('staging storage does not match a passing qualification');
  }
  return {
    vars: { DRIVE_S3_ENDPOINT: settings.endpoint, DRIVE_S3_BUCKET: bucket, DRIVE_S3_REGION: region,
      DRIVE_S3_STORAGE_EPOCH: epoch,
      DRIVE_S3_QUALIFICATION: JSON.stringify({ version, storageConfigId, region, sourceSha, runId, runAttempt, completionTimeoutMs }) },
    secrets: { DRIVE_S3_ACCESS_KEY_ID: accessKeyId, DRIVE_S3_SECRET_ACCESS_KEY: secretAccessKey },
  };
}

function reviewedStorage(env) {
  const receipt = JSON.parse(readFileSync(new URL('./staging-storage-qualification.json', import.meta.url), 'utf8'));
  return stagingStorage(env, receipt);
}

function enrollmentForRelease(grant, sha, preflight) {
  if (!grant) return '';
  const expiresAt = Number(grant.slice(41, 54));
  const now = Date.now();
  if (grant.length !== 98 || !/^[a-f0-9]{40}:\d{13}:[A-Za-z0-9_-]{43}$/.test(grant) ||
      !grant.startsWith(`${sha}:`) || expiresAt > now + 300_000 || (preflight && expiresAt <= now)) {
    throw new Error('invalid, mismatched or expired staging enrollment authorization');
  }
  // A grant that expires during migrations must not prevent publishing the compatible Worker.
  return expiresAt > now ? grant : '';
}

export function publishStaging(root, run = spawn, accountId = process.env.CLOUDFLARE_ACCOUNT_ID, grant = '', sha = '', storage) {
  const config = validateStagingTarget(root, accountId);
  return deploy(root, run, enrollmentForRelease(grant, sha, false), sha, config, storage);
}

async function deploy(root, run, enrollment, sha, config, storage) {
  // Wrangler inherits prior secrets. An inactive publish must explicitly disarm them.
  const args = ['deploy', entryPath, '--config', configPath, '--var',
    `DRIVE_OWNER_ENROLLMENT_RELEASE:${enrollment ? sha : 'disabled'}`];
  using deployDir = storage || enrollment ? mkdtempDisposableSync(resolve(tmpdir(), 'drive-staging-')) : undefined;
  if (storage) {
    const file = resolve(deployDir.path, configPath);
    writeFileSync(file, JSON.stringify({ ...config, main: resolve(root, config.main),
      assets: { ...config.assets, directory: resolve(root, config.assets.directory) },
      d1_databases: config.d1_databases.map(db => ({ ...db, migrations_dir: resolve(root, db.migrations_dir) })),
      vars: storage.vars }), { mode: 0o600, flag: 'wx' });
    args[1] = resolve(root, entryPath);
    args[3] = file;
  }
  if (deployDir) {
    const file = resolve(deployDir.path, 'secrets.json');
    const secrets = { ...storage?.secrets, ...(enrollment ? { DRIVE_OWNER_ENROLLMENT: enrollment } : {}) };
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
    args.push('--secrets-file', file);
  }
  const env = { ...process.env };
  delete env.DRIVE_OWNER_ENROLLMENT;
  for (const key of storageKeys) delete env[`QERITH_S3_${key}`];
  await new Promise((resolveRun, reject) => {
    const child = run(resolve(root, 'node_modules/.bin/wrangler'), args, {
      cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let failed = false;
    const stop = () => {
      failed = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    const timer = setTimeout(stop, 110000);
    for (const stream of [child.stdout, child.stderr]) {
      let bytes = 0;
      stream.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) stop(); });
      stream.on('error', stop);
    }
    child.on('error', stop);
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(); else resolveRun();
    });
  }).catch(() => {
    // Provider diagnostics are untrusted and may include sensitive information.
    throw new Error('staging Worker publication failed');
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--check-target') {
    validateStagingTarget(process.cwd(), process.env.CLOUDFLARE_ACCOUNT_ID);
    enrollmentForRelease(process.env.DRIVE_OWNER_ENROLLMENT, process.env.GITHUB_SHA, true);
  } else if (process.argv.length === 3 && process.argv[2] === '--check-storage') {
    await reviewedStorage(process.env);
  } else if (process.argv.length === 3 && process.argv[2] === '--publish') {
    const env = process.env;
    if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_JOB !== 'publish' ||
        env.GITHUB_REPOSITORY !== 'TogetherWeOwn/qerith' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
        env.GITHUB_REF !== 'refs/heads/main' || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ||
        !env.CLOUDFLARE_API_TOKEN) {
      throw new Error('publication requires the protected staging dispatch job');
    }
    await publishStaging(process.cwd(), spawn, env.CLOUDFLARE_ACCOUNT_ID, env.DRIVE_OWNER_ENROLLMENT, env.GITHUB_SHA,
      await reviewedStorage(env));
  } else {
    throw new Error('unrecognized staging publisher arguments');
  }
}
