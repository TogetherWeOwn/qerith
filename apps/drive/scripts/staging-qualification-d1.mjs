import { execFileSync } from 'node:child_process';
import { assertQualificationJob, qualificationPrefix } from './staging-qualification.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';
import { validateStagingConfig } from './staging-publish.mjs';

const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const bookmarkToken = value => matches(value, /^[A-Za-z0-9_-]{1,1024}$/);
const sameAttempt = ({ sha, runId, attempt }, other) =>
  other?.sha === sha && other.runId === runId && other.attempt === attempt;

function d1(source, env, cwd, send, active) {
  const { sha, runId, attempt } = source;
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token } = env;
  if (!matches(sha, /^[0-9a-f]{40}$/) || ![runId, attempt].every(id => matches(id, /^[1-9][0-9]{0,19}$/)) ||
      typeof token !== 'string' || !token.trim()) throw new Error();
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000,
    maxBuffer: 65_536, stdio: ['ignore', 'pipe', 'pipe'] });
  git('merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main');
  const config = JSON.parse(git('show', `${sha}:apps/drive/wrangler.staging.json`));
  validateStagingConfig(config, accountId);
  const { database_id: databaseId, database_name: name } = config.d1_databases[0];
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
  const call = async (path, method = 'GET', body) => {
    const signal = AbortSignal.any([active, AbortSignal.timeout(8000)]);
    signal.throwIfAborted();
    const response = await send(`${base}${path}`, { method, signal, redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error();
    }
    let size = 0;
    let text = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for await (const chunk of response.body) {
      if ((size += chunk.byteLength) > 65_536) throw new Error();
      text += decoder.decode(chunk, { stream: true });
    }
    signal.throwIfAborted();
    const { success, errors, result } = JSON.parse(text + decoder.decode());
    if (success !== true || !Array.isArray(errors) || errors.length || !result) throw new Error();
    return result;
  };
  return {
    accountId, databaseId, call,
    async verifyTarget() {
      const actual = await call('');
      if (actual.uuid !== databaseId || actual.name !== name || actual.version !== 'production') throw new Error();
    },
    async query(batch) {
      const result = await call('/query', 'POST', JSON.stringify({ batch }));
      if (!Array.isArray(result) || result.length !== batch.length ||
          !result.every(item => item?.success === true && Array.isArray(item.results))) throw new Error();
      return result.map(item => item.results);
    },
  };
}

// Only the synthetic migration fixtures below, not app-created identities or
// upload evidence. The protected caller must reserve these keys and drain their
// writers before cleanup. This function never invokes Time Travel.
export async function cleanQualificationD1(context, env, cwd, signal, send = fetch) {
  try {
    const identity = assertQualificationJob(env, cwd);
    const prefix = qualificationPrefix(identity);
    if (!sameAttempt(identity, context) || context.prefix !== prefix) throw new Error();
    return await runQualificationPhase(async (_, active) => {
      const db = d1(identity, env, cwd, send, active);
      await db.verifyTarget();
      const invite = `${prefix}d1/migration-invite`;
      const ceremony = `${prefix}d1/migration-ceremony`;
      const conditions = ['drive_invitations WHERE id = ?', 'drive_bound_ceremonies WHERE context = ?'];
      const fields = ['id, redeemed_at', 'context, purpose'];
      const params = [[invite], [ceremony]];
      const statements = sql => conditions.map((condition, i) => ({ sql: sql(condition, fields[i], i), params: params[i] }));
      const select = () => db.query(statements((condition, columns) => `SELECT ${columns} FROM ${condition}`));
      const keys = ([invites, ceremonies]) => {
        const purposes = ceremonies.map(row => row?.purpose).sort();
        if (invites.length > 1 || !invites.every(row => row?.id === invite && row.redeemed_at === null) ||
            !ceremonies.every(row => row?.context === ceremony) || new Set(purposes).size !== purposes.length ||
            !purposes.every(purpose => ['registration', 'authentication'].includes(purpose))) throw new Error();
        return JSON.stringify([invites.length, purposes]);
      };
      const before = keys(await select());
      if (before !== '[0,[]]') {
        const removed = await db.query(statements((condition, columns, i) =>
          `DELETE FROM ${condition}${i === 0 ? ' AND redeemed_at IS NULL' : ''} RETURNING ${columns}`));
        if (keys(removed) !== before || keys(await select()) !== '[0,[]]') throw new Error();
      }
      return true;
    }, identity, signal, 45_000);
  } catch {
    throw new Error('Staging D1 migration fixture cleanup is unverified; reconcile before retrying.');
  }
}

function ledger(rows) {
  if (!Array.isArray(rows) || rows.length > 256) throw new Error();
  return rows.map(({ id, name, applied_at }, i) => {
    if (!Number.isSafeInteger(id) || id <= (i ? rows[i - 1].id : 0) ||
        !matches(name, /^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/) ||
        !matches(applied_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)) throw new Error();
    return [id, name, applied_at];
  });
}

// Source/record must be authenticated by the caller. The injected proof must
// independently bind the current bookmark to this failed attempt, account for
// all intervening writes (including pending requests), and hold all writers
// quiescent through readback. ledgerBefore is from before mutation (null if
// absent). A fresh GET of the current bookmark is not a writer proof or fence.
export async function recoverQualificationD1(source, record, { proveQuiescence }, env, cwd, signal, send = fetch) {
  try {
    const { sha, runId, attempt } = source;
    const { bookmark } = record;
    const identity = { sha, runId, attempt };
    if (record.kind !== 'd1' || !sameAttempt(identity, record) || !bookmarkToken(bookmark)) throw new Error();
    return await runQualificationPhase(async (_, active) => {
      const db = d1(identity, env, cwd, send, active);
      const scope = Object.freeze({ ...identity, accountId: db.accountId, databaseId: db.databaseId, bookmark });
      const proof = await proveQuiescence(scope, active);
      const { currentBookmark, ledgerBefore } = proof;
      if (!sameAttempt(identity, proof) || proof.accountId !== scope.accountId || proof.databaseId !== scope.databaseId ||
          proof.bookmark !== bookmark || proof.writersQuiescent !== true || !bookmarkToken(currentBookmark) ||
          currentBookmark <= bookmark) throw new Error();
      const expected = ledgerBefore === null ? null : ledger(ledgerBefore);
      await db.verifyTarget();
      const current = () => db.call('/time_travel/bookmark').then(result => result.bookmark);
      if (await current() !== currentBookmark) throw new Error();
      // At most one native restore. Never infer success from an ambiguous POST.
      const restored = await db.call(`/time_travel/restore?bookmark=${bookmark}`, 'POST');
      if (!bookmarkToken(restored.bookmark) || restored.previous_bookmark !== currentBookmark) throw new Error();
      // Compare against the native restored-state bookmark, not the historical
      // input bookmark. Any mismatch (including maintenance drift) is unverified.
      if (restored.bookmark === currentBookmark || await current() !== restored.bookmark) throw new Error();
      const [tables] = await db.query([{ sql: "SELECT type FROM sqlite_schema WHERE name = 'd1_migrations'" }]);
      if (expected === null) {
        if (tables.length) throw new Error();
      } else {
        if (tables.length !== 1 || tables[0]?.type !== 'table') throw new Error();
        const [rows] = await db.query([{ sql: 'SELECT id, name, applied_at FROM d1_migrations ORDER BY id LIMIT 257' }]);
        if (JSON.stringify(ledger(rows)) !== JSON.stringify(expected)) throw new Error();
      }
      if (await current() !== restored.bookmark) throw new Error();
      return { status: 'restored' };
    }, identity, signal, 45_000);
  } catch {
    throw new Error('Staging D1 recovery is unverified; reconcile the recorded bookmark before retrying.');
  }
}
