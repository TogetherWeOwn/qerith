import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempDisposableSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertQualificationJob } from './staging-qualification.mjs';
import { validateStagingConfig } from './staging-publish.mjs';

const directory = 'apps/drive/migrations';
const target = 'qerith-drive-staging';
const sql = 'SELECT id, name, applied_at FROM d1_migrations ORDER BY id';
const ledgerTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const migrationName = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/;
const configPath = 'apps/drive/wrangler.staging.json';

function verifiedInputs(cwd, sha, accountId) {
  const git = (...args) => execFileSync('git', args, { cwd, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  const entries = git('ls-tree', '-rz', '--full-tree', sha, '--', `${directory}/`).toString('utf8');
  const committedConfig = git('show', `${sha}:${configPath}`);
  const configFile = join(cwd, configPath);
  if (!lstatSync(configFile).isFile() || !readFileSync(configFile).equals(committedConfig)) {
    throw new Error('Staging migration config differs from the tested SHA.');
  }
  const config = JSON.parse(committedConfig);
  validateStagingConfig(config, accountId);
  const inputs = new Map();
  const path = join(cwd, directory);
  if (!entries.endsWith('\0') || !lstatSync(path).isDirectory()) throw new Error('Missing tracked staging migrations.');
  for (const entry of entries.slice(0, -1).split('\0')) {
    const match = /^100(?:644|755) blob ([0-9a-f]{40})\tapps\/drive\/migrations\/([^/]+)$/.exec(entry);
    const name = match?.[2];
    if (!match || !migrationName.test(name)) throw new Error('Invalid tracked staging migration.');
    const file = join(path, name);
    const bytes = git('cat-file', 'blob', match[1]);
    if (!lstatSync(file).isFile() || !readFileSync(file).equals(bytes)) {
      throw new Error('Staging migration bytes differ from the tested SHA.');
    }
    inputs.set(name, bytes);
  }
  if (readdirSync(path).some(name => !inputs.has(name))) throw new Error('Unexpected staging migration input.');
  return { inputs, config: { name: config.name, d1_databases: config.d1_databases } };
}

const readBudget = 45_000;

export function boundedStagingWrangler(binary, cwd, env, args, { timeout, discard = false, signal, applyTimeLeft }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + timeout;
    const child = spawn(binary, [...args, '--config', 'wrangler.staging.json'], {
      cwd, env, detached: true, stdio: ['ignore', discard ? 'ignore' : 'pipe', 'pipe'],
    });
    const output = [];
    let failed = false;
    const stop = () => {
      failed = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    const timer = setTimeout(stop, timeout);
    // A wall-clock step can consume the readback reserve during apply.
    const reserveLost = () => applyTimeLeft && !(applyTimeLeft() > 0);
    const reserveTimer = applyTimeLeft && setInterval(() => { if (reserveLost()) stop(); }, 1_000);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    for (const stream of [child.stdout, child.stderr].filter(Boolean)) {
      let bytes = 0;
      stream.on('error', stop);
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) stop();
        else if (stream === child.stdout) output.push(chunk);
      });
    }
    child.on('error', stop);
    child.on('close', code => {
      clearTimeout(timer);
      clearInterval(reserveTimer);
      signal?.removeEventListener('abort', stop);
      if (failed || code !== 0 || performance.now() >= deadline || reserveLost()) {
        reject(new Error('Bounded staging D1 command failed.'));
      } else resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}

function parseProviderJson(text) {
  try { return JSON.parse(text); } catch { throw new Error('Invalid staging D1 JSON response.'); }
}

function readLedger(text, expected) {
  const response = parseProviderJson(text);
  const rows = response?.[0]?.results;
  if (!Array.isArray(response) || response.length !== 1 || response[0]?.success !== true || !Array.isArray(rows)) {
    throw new Error('Invalid staging D1 migration ledger.');
  }
  const names = new Set();
  let id = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.id) || row.id <= id || !expected.has(row.name) || names.has(row.name) ||
        typeof row.applied_at !== 'string' || !ledgerTime.test(row.applied_at)) {
      throw new Error('Unexpected staging D1 migration ledger entry.');
    }
    names.add(row.name);
    id = row.id;
  }
  return rows.map(({ id, name, applied_at }) => ({ id, name, applied_at }));
}

// The protected caller must verify storage and await durable recovery recording before mutation.
export async function applyQualificationMigrations(options, env, cwd = process.cwd(), signal) {
  cwd = resolve(cwd);
  const identity = assertQualificationJob(env, cwd);
  return applyStagingMigrations(identity, options, env, cwd, signal);
}

// The caller must have independently admitted the exact source and verified storage.
export async function applyStagingMigrations(identity, { recordRecovery, timeLeft }, env, cwd, signal) {
  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = env;
  if (typeof CLOUDFLARE_API_TOKEN !== 'string' || !CLOUDFLARE_API_TOKEN.trim() || typeof recordRecovery !== 'function') {
    throw new Error('Staging migrations require a token and recovery writer.');
  }
  signal?.throwIfAborted();
  const { inputs: expected, config } = verifiedInputs(cwd, identity.sha, CLOUDFLARE_ACCOUNT_ID);
  using snapshotDir = mkdtempDisposableSync(join(tmpdir(), 'drive-d1-inputs-'));
  const migrations = join(snapshotDir.path, 'migrations');
  mkdirSync(migrations, { mode: 0o700 });
  const options = { mode: 0o400, flag: 'wx' };
  writeFileSync(join(snapshotDir.path, 'wrangler.staging.json'), JSON.stringify(config), options);
  for (const [name, bytes] of expected) writeFileSync(join(migrations, name), bytes, options);
  const app = realpathSync(join(cwd, 'apps/drive'));
  const binary = realpathSync(join(app, 'node_modules/.bin/wrangler'));
  if (!binary.startsWith(`${app}${sep}`) || !lstatSync(binary).isFile()) throw new Error('Invalid staging Wrangler path.');
  const run = (args, { timeout = readBudget, reserve = 0, discard } = {}) => {
    const remaining = () => Math.floor(timeLeft?.()) - reserve;
    const available = remaining();
    if (!Number.isFinite(available) || available <= 0 || (reserve > 0 && available < timeout)) {
      throw new Error('Staging D1 migration time budget is exhausted.');
    }
    return boundedStagingWrangler(binary, snapshotDir.path, {
      PATH: env.PATH, HOME: env.HOME, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
      CI: 'true', NO_COLOR: '1', WRANGLER_HIDE_BANNER: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false',
    }, ['d1', ...args], { timeout: Math.min(timeout, available), discard, signal,
      applyTimeLeft: reserve > 0 ? remaining : undefined });
  };
  const snapshot = async () => readLedger(await run(['execute', target, '--remote', '--json', '--command', sql]), expected);
  const bookmark = parseProviderJson(await run(['time-travel', 'info', target, '--json']))?.bookmark;
  if (typeof bookmark !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(bookmark)) {
    throw new Error('Invalid pre-apply staging D1 Time Travel bookmark.');
  }
  // Record the recovery point before any command that can initialize or change the ledger.
  await recordRecovery({ ...identity, bookmark }, signal);
  await run(['migrations', 'list', target, '--remote'], { discard: true });
  const before = await snapshot();
  // Do not spend the time reserved for the post-apply ledger query.
  await run(['migrations', 'apply', target, '--remote'], { timeout: 120_000, reserve: readBudget, discard: true });
  const after = await snapshot();
  if (after.length !== expected.size || before.some(({ id, name, applied_at }, i) =>
    after[i]?.id !== id || after[i].name !== name || after[i].applied_at !== applied_at)) {
    throw new Error('Staging D1 post-apply ledger is incomplete or changed history.');
  }
  return { ...identity, bookmark, before, after };
}
