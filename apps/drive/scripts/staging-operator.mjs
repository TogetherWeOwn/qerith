import { execFileSync } from 'node:child_process';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempDisposableSync,
  openSync, readSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBoundedBody } from '../src/lib/server/bounded-io.ts';
import { reviewedStorage, publishStaging, stagingAccountId, validateStagingTarget } from './staging-publish.mjs';
import { applyStagingMigrations, boundedStagingWrangler } from './staging-qualification-migrations.mjs';

const main = 'refs/heads/main';
const origin = 'https://github.com/TogetherWeOwn/qerith.git';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const minTokenWindow = 10 * 60_000;
const maxTokenWindow = 60 * 60_000;

function readPrivateFile(path) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 ||
        stat.size < 1 || stat.size > 8192) throw new Error('Invalid Operator file.');
    const buffer = Buffer.alloc(8193);
    const size = readSync(file, buffer);
    if (size !== stat.size) throw new Error('Operator file changed during read.');
    return buffer.subarray(0, size).toString('utf8');
  } finally {
    closeSync(file);
  }
}

function requireApproval(stateDir, sha, mode) {
  const approval = readPrivateFile(join(stateDir, 'approved-publish')).trimEnd();
  if (approval !== `${sha} ${mode}`) throw new Error('Requested SHA and mode lack Operator approval.');
}

function command(program, args, { cwd, env, seconds = 15 }) {
  try {
    return execFileSync('/usr/bin/timeout', ['--signal=TERM', '--kill-after=5s', `${seconds}s`, program, ...args], {
      cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(`Operator preflight command failed: ${program} ${args[0]}.`);
  }
}

function buildReviewedSource(sha, scratch, env, run) {
  const git = (...args) => run('git', args, { cwd: scratch, env, seconds: 90 });
  git('init', '--quiet', '--template=');
  git('fetch', '--quiet', '--depth=1', '--no-tags', origin, main);
  if (git('rev-parse', '--verify', 'FETCH_HEAD') !== sha) throw new Error('Approved SHA is not the fetched main tip.');
  git('checkout', '--quiet', '--detach', sha);
  const app = join(scratch, 'apps/drive');
  const runBuild = (program, ...args) => run(program, args, { cwd: app, env, seconds: 180 });
  runBuild('bash', 'scripts/reject-shrinkwrap.sh', '.');
  if (runBuild('node', '--version') !== 'v24.21.0' || runBuild('npm', '--version') !== '11.19.0' ||
      runBuild('npm', 'config', 'get', 'min-release-age') !== '3' ||
      runBuild('npm', 'config', 'get', 'ignore-scripts') !== 'true') throw new Error('Invalid staging build toolchain.');
  runBuild('node', 'scripts/verify-lock-age.mjs');
  runBuild('npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund');
  runBuild('npm', 'run', 'build');
  if (git('rev-parse', '--verify', 'HEAD') !== sha || git('ls-files', '--others', '--', 'apps/drive/migrations')) {
    throw new Error('Staging source changed during build.');
  }
  git('diff', '--exit-code', '--no-ext-diff', 'HEAD', '--');
  return app;
}

async function checkToken(token, send) {
  try {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) throw new Error();
    const signal = AbortSignal.timeout(8000);
    const response = await send('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal,
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error();
    }
    const bytes = await readBoundedBody(response.body, { signal, maxBytes: 8192, timeoutMs: 8000 });
    const body = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
    const expiresOn = body.result?.expires_on;
    const expiry = typeof expiresOn === 'string' ? Date.parse(expiresOn) : NaN;
    const remaining = expiry - Date.now();
    if (body.success !== true || body.result?.status !== 'active' ||
        !(remaining >= minTokenWindow && remaining <= maxTokenWindow)) throw new Error();
    return expiry;
  } catch {
    throw new Error('Cloudflare did not verify an active staging token with 10–60 minutes remaining.');
  }
}

async function deployedVersion(runWrangler) {
  const { versions } = JSON.parse(await runWrangler(['deployments', 'status', '--json']));
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0]?.percentage !== 100 ||
      typeof versions[0].version_id !== 'string' || !uuid.test(versions[0].version_id)) {
    throw new Error('Staging Worker does not have one known serving version.');
  }
  return versions[0].version_id;
}

// Called on demand by the Operator from a trusted installation. There is no hosted caller.
export async function operatorPublish(sha, stateDir, mode = 'closed', { run = command, send = fetch } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !isAbsolute(stateDir ?? '') || !['closed', 'owner-preview'].includes(mode)) {
    throw new Error('Expected an exact SHA, an absolute Operator state directory, and optional owner-preview mode.');
  }
  const state = lstatSync(stateDir);
  if (!state.isDirectory() || state.uid !== process.getuid() || (state.mode & 0o777) !== 0o700) {
    throw new Error('Operator state directory must be private.');
  }
  const pending = join(stateDir, 'publish-in-progress.jsonl');
  let file;
  try {
    file = openSync(pending, 'wx', 0o600);
  } catch {
    throw new Error('Cannot start a publish; check for an in-progress or unreconciled attempt.');
  }
  let admitted = false;
  const record = (phase, data) => {
    writeFileSync(file, JSON.stringify({ sha, mode, phase, ...data }) + '\n');
    fsyncSync(file);
  };
  try {
    requireApproval(stateDir, sha, mode);
    using workspace = mkdtempDisposableSync(join(tmpdir(), 'drive-operator-'));
    const home = join(workspace.path, 'home');
    const scratch = join(workspace.path, 'source');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(scratch, { mode: 0o700 });
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CI: 'true', NO_COLOR: '1',
      WRANGLER_HIDE_BANNER: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    };
    const app = buildReviewedSource(sha, scratch, { ...env, DRIVE_BUILD_SHA: sha }, run);
    const target = validateStagingTarget(app, stagingAccountId);
    const binary = join(app, 'node_modules/.bin/wrangler');
    await boundedStagingWrangler(binary, app, env, ['deploy', '.svelte-kit/cloudflare/_worker.js',
      '--dry-run', '--outdir', join(workspace.path, 'dry-run')], { timeout: 90_000, discard: true });

    requireApproval(stateDir, sha, mode);
    const settings = JSON.parse(readPrivateFile(join(stateDir, 'staging-settings.json')));
    const storage = await reviewedStorage(settings, app);
    const token = settings.CLOUDFLARE_API_TOKEN;
    const tokenExpiry = await checkToken(token, send);
    const publishEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: stagingAccountId, CLOUDFLARE_API_TOKEN: token };
    const runWrangler = (args) => boundedStagingWrangler(binary, app, publishEnv, args, { timeout: 45_000 });
    const previousVersion = await deployedVersion(runWrangler);
    requireApproval(stateDir, sha, mode);
    record('admitted', { previousVersion });
    const stateHandle = openSync(stateDir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(stateHandle); } finally { closeSync(stateHandle); }
    admitted = true;
    const ledger = await applyStagingMigrations({ sha }, {
      recordRecovery: ({ bookmark }) => record('pre-migration', { bookmark }),
      timeLeft: () => tokenExpiry - Date.now() - 205_000,
    }, publishEnv, scratch);
    record('migrated', { before: ledger.before, after: ledger.after });
    const pendingList = await runWrangler(['d1', 'migrations', 'list', target.d1_databases[0].database_name, '--remote']);
    const lines = pendingList.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
    if (lines.length !== 2 || lines[0] !== 'Resource location: remote' || lines[1] !== '✅ No migrations to apply!') {
      throw new Error('Staging D1 still has pending migrations.');
    }
    await publishStaging(app, undefined, stagingAccountId, storage, mode === 'owner-preview', publishEnv);
    const currentVersion = await deployedVersion(runWrangler);
    record('published', { currentVersion });
  } catch (error) {
    if (admitted) throw new Error('Publish outcome needs reconciliation. Preserve the in-progress record before retry.');
    unlinkSync(pending);
    throw error;
  } finally {
    closeSync(file);
  }
  renameSync(pending, join(stateDir, 'last-publish.jsonl'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length < 4 || process.argv.length > 5) throw new Error();
    await operatorPublish(...process.argv.slice(2));
    console.log('Staging publish completed. See last-publish.jsonl for recovery evidence.');
  } catch {
    // Errors from source, settings, or provider output may include private values.
    console.error('Staging publish stopped. Check Operator approval, preflight and the private recovery record.');
    process.exitCode = 1;
  }
}
