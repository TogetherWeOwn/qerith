import { execFileSync, spawn } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertDispatch } from './staging-qualification.mjs';
import { validateStagingTarget } from './staging-publish.mjs';

const directory = 'apps/drive/migrations';
const target = 'qerith-drive-staging';
const sql = 'SELECT id, name, applied_at FROM d1_migrations ORDER BY id';
const ledgerTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const migrationName = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/;
const runNumber = /^[1-9][0-9]{0,19}$/;

function migrationNames(cwd, sha) {
  const git = (...args) => execFileSync('git', args, { cwd, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  const entries = git('ls-tree', '-rz', '--full-tree', sha, '--', `${directory}/`).toString('utf8');
  const names = new Set();
  const path = join(cwd, directory);
  if (!entries.endsWith('\0') || !lstatSync(path).isDirectory()) throw new Error('Missing tracked staging migrations.');
  for (const entry of entries.slice(0, -1).split('\0')) {
    const match = /^100(?:644|755) blob ([0-9a-f]{40})\tapps\/drive\/migrations\/([^/]+)$/.exec(entry);
    const name = match?.[2];
    if (!match || !migrationName.test(name)) throw new Error('Invalid tracked staging migration.');
    const file = join(path, name);
    if (!lstatSync(file).isFile() || !readFileSync(file).equals(git('cat-file', 'blob', match[1]))) {
      throw new Error('Staging migration bytes differ from the tested SHA.');
    }
    names.add(name);
  }
  if (readdirSync(path).some(name => !names.has(name))) throw new Error('Unexpected staging migration input.');
  return names;
}

function wrangler(cwd, env, args, { timeout = 45_000, discard = false, signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(join(cwd, 'node_modules/.bin/wrangler'), [...args, '--config', 'wrangler.staging.json'], {
      cwd, env, detached: true, stdio: ['ignore', discard ? 'ignore' : 'pipe', 'pipe'],
    });
    const output = [];
    let failed = false;
    const stop = () => {
      failed = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
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
      signal?.removeEventListener('abort', stop);
      if (failed || code !== 0) reject(new Error('Bounded staging D1 command failed.'));
      else resolve(Buffer.concat(output).toString('utf8'));
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

// No CLI entry point. The protected orchestrator must verify storage and recovery preconditions before calling.
export async function applyQualificationMigrations(env, cwd = process.cwd(), signal) {
  const sha = assertDispatch(env, cwd);
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN } = env;
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_JOB !== 'qualification' || !CLOUDFLARE_API_TOKEN ||
      !runNumber.test(runId ?? '') || !runNumber.test(attempt ?? '')) {
    throw new Error('Staging migrations require the protected qualification job.');
  }
  const app = join(cwd, 'apps/drive');
  validateStagingTarget(app, CLOUDFLARE_ACCOUNT_ID);
  const expected = migrationNames(cwd, sha);
  const run = (args, options) => wrangler(app, {
    PATH: env.PATH, HOME: env.HOME, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
    CI: 'true', NO_COLOR: '1', WRANGLER_HIDE_BANNER: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false',
  }, ['d1', ...args], { ...options, signal });
  const snapshot = async () => readLedger(await run(['execute', target, '--remote', '--json', '--command', sql]), expected);
  const bookmark = parseProviderJson(await run(['time-travel', 'info', target, '--json']))?.bookmark;
  if (typeof bookmark !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(bookmark)) {
    throw new Error('Invalid pre-apply staging D1 Time Travel bookmark.');
  }
  // Record the recovery point before any command that can initialize or change the ledger.
  console.log(`Pre-apply staging D1 Time Travel bookmark (SHA ${sha}, run ${runId}, attempt ${attempt}): ${bookmark}`);
  await run(['migrations', 'list', target, '--remote'], { discard: true });
  const before = await snapshot();
  await run(['migrations', 'apply', target, '--remote'], { timeout: 120_000, discard: true });
  const after = await snapshot();
  if (after.length !== expected.size || before.some(({ id, name, applied_at }, i) =>
    after[i]?.id !== id || after[i].name !== name || after[i].applied_at !== applied_at)) {
    throw new Error('Staging D1 post-apply ledger is incomplete or changed history.');
  }
  return { sha, runId, attempt, bookmark, before, after };
}
