import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { cleanQualificationD1, recoverQualificationD1 } from './staging-qualification-d1.mjs';

const config = new URL('../wrangler.staging.json', import.meta.url);
const migrations = new URL('../migrations/', import.meta.url);
const databaseId = JSON.parse(readFileSync(config)).d1_databases[0].database_id;
const accountId = '209cf7dd678adfb683947dd7874d05af';
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
const prefix = 'drive-qualification/full-v0/17/2/';
const invite = p => `${p}d1/migration-invite`;
const ceremony = p => `${p}d1/migration-ceremony`;
const other = ['drive-qualification/full-v0/17/1/', 'drive-qualification/full-v0/17/20/',
  'drive-qualification/full-v0/170/2/', 'unrelated/'];
const restore = '/time_travel/restore?bookmark=01-baseline';
const ok = result => Response.json({ success: true, errors: [], result });
const cleanupError = /fixture cleanup is unverified/;
const recoveryError = /D1 recovery is unverified/;

function fixture(t, { emptyBaseline = false } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'drive-d1-recovery-'));
  mkdirSync(join(cwd, 'apps/drive'), { recursive: true });
  cpSync(config, join(cwd, 'apps/drive/wrangler.staging.json'));
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
    env: { HOME: cwd, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('add', 'apps/drive/wrangler.staging.json');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const source = { sha, runId: '17', attempt: '2' };
  const env = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'synthetic', GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/drive-staging-qualification.yml@refs/heads/main',
    GITHUB_JOB: 'qualification', GITHUB_REPOSITORY: 'TogetherWeOwn/qerith', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', TESTED_SHA: sha, GITHUB_SHA: sha, GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '2' };
  const before = '01-baseline';
  const failed = '02-failed';
  const postRestore = '03-restored';
  const record = { kind: 'd1', ...source, bookmark: before };
  const ledger = 'SELECT id, name, applied_at FROM d1_migrations ORDER BY id';
  function baseline() {
    const db = new DatabaseSync(':memory:');
    if (emptyBaseline) return db;
    db.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TEXT);
      PRAGMA foreign_keys = ON`);
    for (const [index, name] of readdirSync(migrations).sort().entries()) {
      db.exec(readFileSync(new URL(name, migrations), 'utf8'));
      db.prepare('INSERT INTO d1_migrations VALUES (?, ?, ?)').run(index + 1, name, '2026-11-20 10:00:00');
    }
    return db;
  }
  let db = baseline();
  t.after(() => { db.close(); rmSync(cwd, { recursive: true, force: true }); });
  const historical = emptyBaseline ? null : db.prepare(ledger).all();
  const proof = { ...source, accountId, databaseId, bookmark: before, currentBookmark: failed,
    ledgerBefore: historical, writersQuiescent: true };
  let current = failed;
  const calls = [];
  const simulatedFetch = (path, { method, body }) => {
    if (path === '' && method === 'GET') return ok({ uuid: databaseId, name: 'qerith-drive-staging', version: 'production' });
    if (path === '/time_travel/bookmark' && method === 'GET') return ok({ bookmark: current });
    if (path === restore && method === 'POST') {
      const previous_bookmark = current;
      db.close();
      db = baseline();
      current = postRestore;
      return ok({ bookmark: current, previous_bookmark });
    }
    assert.equal(path, '/query');
    assert.equal(method, 'POST');
    db.exec('BEGIN');
    try {
      const results = JSON.parse(body).batch.map(({ sql, params = [] }) =>
        ({ success: true, results: db.prepare(sql).all(...params) }));
      db.exec('COMMIT');
      return ok(results);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  let intercept = (path, init) => simulatedFetch(path, init);
  const send = async (url, init) => {
    assert.ok(url.startsWith(base) && ['', '/', '?'].includes(url.slice(base.length, base.length + 1)));
    assert.equal(init.headers.authorization, 'Bearer synthetic');
    assert.equal(init.redirect, 'error');
    init.signal.throwIfAborted();
    const path = url.slice(base.length);
    calls.push(init.body?.includes('DELETE FROM') ? 'DELETE batch' : path);
    return intercept(path, init);
  };
  return { calls, historical, proof, sql: (sql, ...params) => db.prepare(sql).all(...params),
    seed() {
      for (const [i, p] of [prefix, ...other].entries()) {
        db.prepare(`INSERT INTO drive_invitations (id, token_hash, expires_at, display_name, note, created_at)
          VALUES (?, ?, 10, 'Fixture', 'Migration fixture', 1)`).run(invite(p), String(i).repeat(64));
        for (const purpose of ['registration', 'authentication']) {
          db.prepare(`INSERT INTO drive_bound_ceremonies (context, purpose, challenge, expires_at, principal_id, webauthn_user_handle)
            VALUES (?, ?, ?, 10, 'fixture-principal', 'handle')`).run(ceremony(p), purpose, `${i}-${purpose}`);
        }
      }
    },
    intercept(fn) { intercept = (path, init) => fn(path, init, () => simulatedFetch(path, init)); },
    clean: (patch = {}, signal) => cleanQualificationD1({ ...source, prefix, ...patch }, env, cwd, signal, send),
    recover: ({ overrides, recordPatch, proveQuiescence = (scope, signal) => {
      assert.deepEqual(scope, { ...source, accountId, databaseId, bookmark: before });
      assert.equal(signal.aborted, false);
      return proof;
    }, signal } = {}) => recoverQualificationD1({ ...source, ...overrides }, { ...record, ...recordPatch },
      { proveQuiescence }, env, cwd, signal, send),
  };
}

test('teardown removes only exact-attempt migration fixtures and leaves the historical ledger intact', async t => {
  const f = fixture(t);
  f.seed();
  await assert.rejects(f.clean({ attempt: '1', prefix: other[0] }), cleanupError);
  await assert.rejects(f.clean({ prefix: other[1] }), cleanupError);
  assert.deepEqual(f.calls, []);
  assert.equal(await f.clean(), true);
  assert.deepEqual(f.calls, ['', '/query', 'DELETE batch', '/query']);
  assert.deepEqual(f.sql('SELECT id FROM drive_invitations').map(row => row.id).sort(), other.map(invite).sort());
  assert.deepEqual(f.sql('SELECT context FROM drive_bound_ceremonies').map(row => row.context).sort(), other.flatMap(p =>
    [ceremony(p), ceremony(p)]).sort());
  assert.deepEqual(f.sql('SELECT id, name, applied_at FROM d1_migrations ORDER BY id'), f.historical);
  f.calls.length = 0;
  assert.equal(await f.clean(), true);
  assert.deepEqual(f.calls, ['', '/query']);
});

test('teardown refuses redeemed fixtures, unknown targets, ambiguous writes and surviving rows', async t => {
  const f = fixture(t);
  f.seed();
  f.intercept(() => ok({ uuid: databaseId, name: 'unknown', version: 'production' }));
  await assert.rejects(f.clean(), cleanupError);
  assert.deepEqual(f.calls.splice(0), ['']);
  f.intercept((_, __, run) => run());
  f.sql('UPDATE drive_invitations SET redeemed_at = 5 WHERE id = ?', invite(prefix));
  await assert.rejects(f.clean(), cleanupError);
  assert.deepEqual(f.calls.splice(0), ['', '/query']);
  f.sql('UPDATE drive_invitations SET redeemed_at = NULL WHERE id = ?', invite(prefix));
  f.intercept((_, init, run) => init.body?.includes('DELETE FROM') ? ok([
    { success: true, results: [{ id: invite(prefix), redeemed_at: null }] },
    { success: true, results: ['registration', 'authentication'].map(purpose => ({ context: ceremony(prefix), purpose })) },
  ]) : run());
  await assert.rejects(f.clean(), cleanupError);
  assert.deepEqual(f.calls.splice(0), ['', '/query', 'DELETE batch', '/query']);
  f.intercept((_, init, run) => {
    const result = run();
    if (init.body?.includes('DELETE FROM')) throw new Error('synthetic lost response');
    return result;
  });
  await assert.rejects(f.clean(), { message: 'Staging D1 migration fixture cleanup is unverified; reconcile before retrying.' });
  assert.deepEqual(f.calls, ['', '/query', 'DELETE batch']);
});

test('recovery restores the recorded pre-mutation schema and ledger, including a previously absent ledger', async t => {
  for (const emptyBaseline of [false, true]) {
    const f = fixture(t, { emptyBaseline });
    f.sql('CREATE TABLE interrupted_migration (id INTEGER)');
    if (emptyBaseline) f.sql('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
    f.sql("INSERT INTO d1_migrations VALUES (999, 'interrupted.sql', '2026-11-20 11:00:00')");
    assert.deepEqual(await f.recover(), { status: 'restored' });
    assert.deepEqual(f.calls, ['', '/time_travel/bookmark', restore, '/time_travel/bookmark', '/query',
      ...(emptyBaseline ? [] : ['/query'])]);
    assert.deepEqual(f.sql("SELECT name FROM sqlite_schema WHERE name = 'interrupted_migration'"), []);
    if (!emptyBaseline) assert.deepEqual(f.sql('SELECT id, name, applied_at FROM d1_migrations ORDER BY id'), f.historical);
    await assert.rejects(f.recover(), recoveryError);
    assert.deepEqual(f.calls.slice(-2), ['', '/time_travel/bookmark']);
  }
});

test('recovery will not restore without exact source, authenticated proof, and unchanged native target', async t => {
  const f = fixture(t);
  for (const input of [{ overrides: { sha: 'b'.repeat(40) } }, { recordPatch: { attempt: '1' } },
    { recordPatch: { bookmark: '01-baseline?foo' } }, { proveQuiescence: () => true },
    ...[{ writersQuiescent: false }, { databaseId: 'elsewhere' }, { currentBookmark: '00-older' },
      { attempt: '20' }, { ledgerBefore: undefined }].map(patch => ({ proveQuiescence: () => ({ ...f.proof, ...patch }) })),
    { signal: AbortSignal.abort() }]) {
    await assert.rejects(f.recover(input), recoveryError);
    assert.deepEqual(f.calls, []);
  }
  f.intercept((path, _, run) => path === '' ? ok({ uuid: databaseId, name: 'unknown', version: 'production' }) : run());
  await assert.rejects(f.recover(), recoveryError);
  assert.deepEqual(f.calls.splice(0), ['']);
  f.intercept((path, _, run) => path === '/time_travel/bookmark' ? ok({ bookmark: '04-superseding' }) : run());
  await assert.rejects(f.recover(), recoveryError);
  assert.deepEqual(f.calls, ['', '/time_travel/bookmark']);
});

test('recovery does not retry a lost response or certify a wrong bookmark or rewritten history', async t => {
  for (const fault of ['lost', 'wrong-prior', 'unchanged', 'superseded', 'rewritten']) {
    const f = fixture(t);
    f.intercept((path, _, run) => {
      if (path === '/time_travel/bookmark' && f.calls.includes(restore) && fault === 'superseded') {
        return ok({ bookmark: '04-superseding' });
      }
      if (path !== restore) return run();
      if (fault === 'unchanged') return ok({ bookmark: '01-baseline', previous_bookmark: '02-failed' });
      const result = run();
      if (fault === 'lost') throw new Error('synthetic lost response');
      if (fault === 'wrong-prior') return ok({ bookmark: '03-restored', previous_bookmark: '02-foreign' });
      if (fault === 'rewritten') f.sql("UPDATE d1_migrations SET applied_at = '2026-11-20 22:00:00' WHERE id = 1");
      return result;
    });
    await assert.rejects(f.recover(), recoveryError);
    assert.deepEqual(f.calls.slice(0, 3), ['', '/time_travel/bookmark', restore]);
    assert.equal(f.calls.filter(call => call.startsWith('/time_travel/restore')).length, 1);
  }
});
