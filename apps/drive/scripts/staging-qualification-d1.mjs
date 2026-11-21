import { execFileSync } from 'node:child_process';
import { assertQualificationJob, qualificationFixtureNamespace, qualificationPrefix } from './staging-qualification.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';
import { validateStagingConfig } from './staging-publish.mjs';

const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const bookmarkToken = value => matches(value, /^[A-Za-z0-9_-]{1,1024}$/);
const sameAttempt = ({ sha, runId, attempt }, other) =>
  other?.sha === sha && other.runId === runId && other.attempt === attempt;
const migrationInvite = 'd1/migration-invite';
const migrationCeremony = 'd1/migration-ceremony';

function d1(source, env, cwd, send, active, { census = false } = {}) {
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
    // Readback also uses POST /query; its envelope must still be complete.
    if (response.status !== 200 || response.headers.has('content-range') || !response.body) {
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
    const payload = JSON.parse(text + decoder.decode());
    const { success, errors, result } = payload;
    if (success !== true || !Array.isArray(errors) || errors.length || !result ||
        (census && Object.hasOwn(payload, 'result_info'))) throw new Error();
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

// GLOB narrows the index range but '*' can cross slashes. Validate the
// remaining run/attempt pair against the D1 client's bounded ID grammar.
function migrationFixtureExists(table, key, suffix) {
  const start = qualificationFixtureNamespace.length + 1;
  return `EXISTS(SELECT 1 FROM (
    SELECT substr(${key}, ${start}, length(${key}) - ${start + suffix.length}) AS ids
    FROM ${table} WHERE ${key} GLOB ? AND instr(${key}, char(0)) = 0
  ) WHERE trim(ids, '0123456789') = '/' AND instr(ids, '/') <= 21
    AND length(ids) - instr(ids, '/') <= 20)`;
}

// A point-in-time read of both migration fixture keys across every full-v0
// attempt. This neither discovers other app fixtures nor excludes writers.
export async function assertNoQualificationD1MigrationFixtures(env, cwd, signal, send) {
  try {
    signal?.throwIfAborted();
    const identity = assertQualificationJob(env, cwd);
    return await runQualificationPhase(async (_, active) => {
      const db = d1(identity, env, cwd, send, active, { census: true });
      await db.verifyTarget();
      const pattern = suffix => `${qualificationFixtureNamespace}[1-9]*/[1-9]*/${suffix}`;
      const [rows] = await db.query([{
        sql: `SELECT ${migrationFixtureExists('drive_invitations', 'id', migrationInvite)} AS invite_present,
                     ${migrationFixtureExists('drive_bound_ceremonies', 'context', migrationCeremony)} AS ceremony_present`,
        params: [pattern(migrationInvite), pattern(migrationCeremony)],
      }]);
      const [row] = rows;
      if (rows.length !== 1 || row?.invite_present !== 0 || row.ceremony_present !== 0 ||
          Object.keys(row).length !== 2) throw new Error();
      return true;
    }, identity, signal, 20_000);
  } catch {
    throw new Error('Staging D1 migration fixture absence is unverified.');
  }
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
      const invite = `${prefix}${migrationInvite}`;
      const ceremony = `${prefix}${migrationCeremony}`;
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
      // Native responses can echo the target or report the new live head; the
      // latter must match an independent read under the same writer fence.
      if (!bookmarkToken(restored.bookmark) || !bookmarkToken(restored.previous_bookmark)) throw new Error();
      const restoredHead = await current();
      if (!bookmarkToken(restoredHead) || restoredHead === currentBookmark ||
          (restored.bookmark !== bookmark && restored.bookmark !== restoredHead)) throw new Error();
      const [tables] = await db.query([{ sql: "SELECT type FROM sqlite_schema WHERE name = 'd1_migrations' COLLATE NOCASE" }]);
      if (expected === null) {
        if (tables.length) throw new Error();
      } else {
        if (tables.length !== 1 || tables[0]?.type !== 'table') throw new Error();
        const [rows] = await db.query([{ sql: 'SELECT id, name, applied_at FROM d1_migrations ORDER BY id LIMIT 257' }]);
        if (JSON.stringify(ledger(rows)) !== JSON.stringify(expected)) throw new Error();
      }
      if (await current() !== restoredHead) throw new Error();
      return { status: 'restored' };
    }, identity, signal, 45_000);
  } catch {
    throw new Error('Staging D1 recovery is unverified; reconcile the recorded bookmark before retrying.');
  }
}
