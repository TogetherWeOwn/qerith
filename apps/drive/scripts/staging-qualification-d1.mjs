import { execFileSync } from 'node:child_process';
import { assertQualificationJob, qualificationFixtureNamespace, qualificationPrefix } from './staging-qualification.mjs';
import { assertReviewedEmptyCatalog, censusSql, reviewedMigrationTree } from './staging-qualification-d1-profile.mjs';
import { hasDuplicateMembers } from './staging-qualification-json.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';
import { validateStagingConfig } from './staging-publish.mjs';

const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const bookmarkToken = value => matches(value, /^[A-Za-z0-9_-]{1,1024}$/);
const sameAttempt = ({ sha, runId, attempt }, other) =>
  other?.sha === sha && other.runId === runId && other.attempt === attempt;
const migrationInvite = 'd1/migration-invite';
const migrationCeremony = 'd1/migration-ceremony';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000,
  maxBuffer: 65_536, stdio: ['ignore', 'pipe', 'pipe'] });

function validReadMeta(meta) {
  return meta && typeof meta === 'object' && !Array.isArray(meta) && Object.entries(meta).every(([key, value]) => {
    switch (key) {
      case 'changes': case 'rows_written': return value === 0;
      case 'changed_db': return value === false;
      case 'served_by_primary': return value === true;
      case 'served_by': case 'served_by_region': case 'served_by_colo': return typeof value === 'string';
      case 'duration': return Number.isFinite(value) && value >= 0;
      case 'last_row_id': case 'size_after': case 'rows_read': case 'total_attempts':
        return Number.isSafeInteger(value) && value >= 0;
      case 'timings': return Number.isFinite(value?.sql_duration_ms) && value.sql_duration_ms >= 0 &&
        Object.keys(value).length === 1;
      default: return false;
    }
  });
}

function d1(source, env, cwd, send, active, { census = false, strict = false } = {}) {
  const { sha, runId, attempt } = source;
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token } = env;
  if (!matches(sha, /^[0-9a-f]{40}$/) || ![runId, attempt].every(id => matches(id, /^[1-9][0-9]{0,19}$/)) ||
      typeof token !== 'string' || !token.trim()) throw new Error();
  git(cwd, 'merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main');
  const config = JSON.parse(git(cwd, 'show', `${sha}:apps/drive/wrangler.staging.json`));
  validateStagingConfig(config, accountId);
  const { database_id: databaseId, database_name: name } = config.d1_databases[0];
  const collection = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`;
  const read = async (url, method = 'GET', body, list = false) => {
    const signal = AbortSignal.any([active, AbortSignal.timeout(8000)]);
    signal.throwIfAborted();
    const response = await send(url, { method, signal, redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    // Readback also uses POST /query; its envelope must still be complete.
    if (signal.aborted || response.status !== 200 || response.headers.has('content-range') || !response.body ||
        ((list || strict) && response.headers.has('link'))) {
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
    if (strict && response.headers.has('content-length') && !response.headers.has('content-encoding')) {
      if (response.headers.get('content-length') !== String(size)) throw new Error();
    }
    text += decoder.decode();
    const payload = JSON.parse(text, strict ? (key, value, context) => {
      if (['changes', 'rows_written'].includes(key) && context?.source !== '0') throw new Error();
      return value;
    } : undefined);
    const { success, errors, result } = payload;
    if (success !== true || !Array.isArray(errors) || errors.length || !result) throw new Error();
    if (strict && (hasDuplicateMembers(text) ||
        Object.keys(payload).some(key => !['success', 'errors', 'result', 'messages'].includes(key)) ||
        (Object.hasOwn(payload, 'messages') && (!Array.isArray(payload.messages) || payload.messages.length)))) throw new Error();
    return payload;
  };
  const call = async (path, method, body) => {
    const payload = await read(`${collection}/${databaseId}${path}`, method, body);
    if (census && Object.hasOwn(payload, 'result_info')) throw new Error();
    return payload.result;
  };
  return {
    accountId, databaseId, call,
    async verifyRoster() {
      // The pinned Wrangler client ends the unfiltered listing on a short page.
      const perPage = 10;
      const payload = await read(`${collection}?page=1&per_page=${perPage}`, 'GET', undefined, true);
      const { result, result_info: page } = payload;
      if (Object.keys(payload).some(key => !['success', 'errors', 'messages', 'result', 'result_info'].includes(key)) ||
          (Object.hasOwn(payload, 'messages') && (!Array.isArray(payload.messages) || payload.messages.length)) ||
          !Array.isArray(result) || result.length !== 1 || result[0]?.uuid !== databaseId || result[0]?.name !== name) throw new Error();
      if (Object.hasOwn(payload, 'result_info')) {
        const complete = { page: 1, per_page: perPage, count: 1, total_count: 1, total_pages: 1 };
        if (!page || typeof page !== 'object' || Array.isArray(page) ||
            Object.entries(page).some(([key, value]) => !Object.hasOwn(complete, key) || complete[key] !== value)) throw new Error();
      }
    },
    async verifyTarget() {
      const actual = await call('');
      if (actual.uuid !== databaseId || actual.name !== name || actual.version !== 'production') throw new Error();
    },
    async query(batch) {
      const result = await call('/query', 'POST', JSON.stringify({ batch }));
      if (!Array.isArray(result) || result.length !== batch.length ||
          !result.every(item => item?.success === true && Array.isArray(item.results))) throw new Error();
      if (strict && result.some(item => Object.keys(item).some(key => !['success', 'results', 'meta'].includes(key)) ||
          (Object.hasOwn(item, 'meta') && !validReadMeta(item.meta)))) throw new Error();
      return result.map(item => item.results);
    },
  };
}

// Point-in-time inventory for a fully migrated, exclusively synthetic staging
// database. The caller must independently establish writer quiescence.
// An explicit transport is required so offline callers cannot fall back to fetch.
export async function readQualificationD1AppFixtures(scope, env, cwd, signal, send) {
  try {
    signal?.throwIfAborted();
    if (typeof send !== 'function') throw new Error();
    const identity = assertQualificationJob(env, cwd);
    if (!sameAttempt(identity, scope)) throw new Error();
    return await runQualificationPhase(async (_, active) => {
      const tree = `${identity.sha}:apps/drive/migrations`;
      if (git(cwd, 'rev-parse', '--verify', tree).trim() !== reviewedMigrationTree) throw new Error();
      const names = git(cwd, 'ls-tree', '--full-tree', '--name-only', '-z', tree).slice(0, -1).split('\0');
      const db = d1(identity, env, cwd, send, active, { strict: true });
      if (scope.account !== db.accountId || scope.database !== db.databaseId) throw new Error();
      await db.verifyTarget();
      const [rows] = await db.query([{ sql: censusSql, params: [JSON.stringify(names)] }]);
      assertReviewedEmptyCatalog(rows);
      return { complete: true, items: [] };
    }, identity, signal, 20_000);
  } catch {
    throw new Error('Staging D1 app table emptiness is unverified.');
  }
}

// This independently cross-checks the account-visible roster, not compute mode.
export async function assertQualificationD1Roster(env, cwd, signal, send) {
  try {
    signal?.throwIfAborted();
    const identity = assertQualificationJob(env, cwd);
    await runQualificationPhase((_, active) => d1(identity, env, cwd, send, active).verifyRoster(), identity, signal, 20_000);
  } catch {
    throw new Error('Staging D1 database roster is unverified.');
  }
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
