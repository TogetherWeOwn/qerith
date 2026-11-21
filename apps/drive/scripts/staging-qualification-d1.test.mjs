import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertNoQualificationD1MigrationFixtures, cleanQualificationD1, readQualificationD1AppFixtures, recoverQualificationD1,
} from './staging-qualification-d1.mjs';

const config = new URL('../wrangler.staging.json', import.meta.url);
const migrations = new URL('../migrations/', import.meta.url);
const databaseId = JSON.parse(readFileSync(config)).d1_databases[0].database_id;
const accountId = '209cf7dd678adfb683947dd7874d05af';
const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
const prefix = 'drive-qualification/full-v0/17/2/';
const invite = p => `${p}d1/migration-invite`;
const ceremony = p => `${p}d1/migration-ceremony`;
const other = ['drive-qualification/full-v0/17/1/', 'drive-qualification/full-v0/17/20/',
  'drive-qualification/full-v0/170/2/', 'unrelated/', `${prefix}decoy/`];
const restore = '/time_travel/restore?bookmark=01-baseline';
const ok = result => Response.json({ success: true, errors: [], result });
const cleanupError = /fixture cleanup is unverified/;
const recoveryError = /D1 recovery is unverified/;
const censusError = /^Error: Staging D1 app table emptiness is unverified\.$/;
const censusScope = { account: accountId, database: databaseId };

function fixture(t, { emptyBaseline = false, echoTarget = true, reviewedCensus = false, migrationLimit, sourceDrift } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'drive-d1-recovery-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, 'apps/drive'), { recursive: true });
  cpSync(config, join(cwd, 'apps/drive/wrangler.staging.json'));
  const gitOutput = (...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8',
    env: { HOME: cwd, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const git = (...args) => gitOutput(...args).trim();
  git('init', '-b', 'main');
  let names = readdirSync(migrations).sort();
  if (reviewedCensus) {
    const repo = fileURLToPath(new URL('../../../', import.meta.url));
    const committed = (...args) => execFileSync('/usr/bin/git', ['-C', repo, ...args]);
    const path = 'apps/drive/migrations';
    names = committed('ls-tree', '--name-only', '-z', `HEAD:${path}`).toString().slice(0, -1).split('\0');
    mkdirSync(join(cwd, path));
    for (const name of names) writeFileSync(join(cwd, path, name), committed('show', `HEAD:${path}/${name}`));
    if (sourceDrift) writeFileSync(join(cwd, path, names[0]), '\n-- Unreviewed source.\n', { flag: 'a' });
  }
  git('add', 'apps/drive');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const source = { sha, runId: '17', attempt: '2' };
  const env = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'synthetic', GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW_SHA: sha,
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
    // This is the ledger DDL in pinned Wrangler 4.160.1.
    db.exec(reviewedCensus ? `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);` : 'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TEXT);');
    db.exec('PRAGMA foreign_keys = ON');
    for (const [index, name] of names.slice(0, migrationLimit).entries()) {
      db.exec(reviewedCensus ? gitOutput('show', `${sha}:apps/drive/migrations/${name}`) :
        readFileSync(new URL(name, migrations), 'utf8'));
      db.prepare('INSERT INTO d1_migrations VALUES (?, ?, ?)').run(index + 1, name, '2026-11-20 10:00:00');
    }
    return db;
  }
  let db = baseline();
  t.after(() => db.close());
  const historical = emptyBaseline ? null : db.prepare(ledger).all();
  const proof = { ...source, accountId, databaseId, bookmark: before, currentBookmark: failed,
    ledgerBefore: historical, writersQuiescent: true };
  let current = failed;
  const calls = [];
  const simulatedFetch = (path, { method, body }) => {
    if (path === '' && method === 'GET') return ok({ uuid: databaseId, name: 'qerith-drive-staging', version: 'production' });
    if (path === '/time_travel/bookmark' && method === 'GET') return ok({ bookmark: current });
    if (path === restore && method === 'POST') {
      db.close();
      db = baseline();
      current = postRestore;
      return ok({ bookmark: echoTarget ? before : postRestore, previous_bookmark: '02-undo-point' });
    }
    assert.equal(path, '/query');
    assert.equal(method, 'POST');
    const { batch } = JSON.parse(body);
    if (reviewedCensus) {
      assert.equal(batch.length, 1);
      db.exec('PRAGMA query_only = ON');
    }
    db.exec('BEGIN');
    try {
      const results = batch.map(({ sql, params = [] }) =>
        ({ success: true, results: db.prepare(sql).all(...params) }));
      db.exec('COMMIT');
      return ok(results);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      if (reviewedCensus) db.exec('PRAGMA query_only = OFF');
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
    seed(prefixes = [prefix, ...other]) {
      for (const [i, p] of prefixes.entries()) {
        db.prepare(`INSERT INTO drive_invitations (id, token_hash, expires_at, display_name, note, created_at)
          VALUES (?, ?, 10, 'Fixture', 'Migration fixture', 1)`).run(invite(p), String(i).repeat(64));
        for (const purpose of ['registration', 'authentication']) {
          db.prepare(`INSERT INTO drive_bound_ceremonies (context, purpose, challenge, expires_at, principal_id, webauthn_user_handle)
            VALUES (?, ?, ?, 10, 'fixture-principal', 'handle')`).run(ceremony(p), purpose, `${i}-${purpose}`);
        }
      }
    },
    intercept(fn) { intercept = (path, init) => fn(path, init, () => simulatedFetch(path, init)); },
    inspect: (patch = {}, signal) => assertNoQualificationD1MigrationFixtures({ ...env, ...patch }, cwd, signal, send),
    census: ({ scope = censusScope, patch = {}, signal, transport = send } = {}) =>
      readQualificationD1AppFixtures(scope, { ...env, ...patch }, cwd, signal, transport),
    clean: (patch = {}, signal) => cleanQualificationD1({ ...source, prefix, ...patch }, env, cwd, signal, send),
    recover: ({ overrides, recordPatch, proveQuiescence = (scope, signal) => {
      assert.deepEqual(scope, { ...source, accountId, databaseId, bookmark: before });
      assert.equal(signal.aborted, false);
      return proof;
    }, signal } = {}) => recoverQualificationD1({ ...source, ...overrides }, { ...record, ...recordPatch },
      { proveQuiescence }, env, cwd, signal, send),
  };
}

test('app table census covers the committed fully migrated schema and returns an empty inventory scan', async t => {
  const f = fixture(t, { reviewedCensus: true });
  assert.equal(f.historical.length, 37);
  assert.equal(f.sql("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")[0].n, 35);
  assert.deepEqual(await f.census(), { complete: true, items: [] });
  assert.deepEqual(f.calls, ['', '/query']);
});

test('app table census rejects expired, unnamed and permanent rows under the real guards', async t => {
  const f = fixture(t, { reviewedCensus: true });
  f.sql("INSERT INTO drive_webauthn_challenges VALUES ('opaque-challenge', 'authentication', 1, 1)");
  await assert.rejects(f.census(), censusError);
  f.sql('DELETE FROM drive_webauthn_challenges');
  f.sql("INSERT INTO drive_principals (id, role, status) VALUES ('opaque-principal', 'member', 'revoked')");
  assert.equal(f.sql('SELECT display_name FROM drive_principals')[0].display_name, null);
  await assert.rejects(f.census(), censusError);
  f.sql('DELETE FROM drive_principals');
  assert.deepEqual(await f.census(), { complete: true, items: [] });
  f.sql("INSERT INTO drive_upload_key_reservations VALUES ('opaque-key')");
  await assert.rejects(f.census(), censusError);
  assert.throws(() => f.sql('DELETE FROM drive_upload_key_reservations'), /reservations are permanent/);
  assert.equal(f.sql('SELECT count(*) AS n FROM drive_upload_key_reservations')[0].n, 1);
});

test('app table census rejects uninitialized, partially migrated and drifted baselines', async t => {
  for (const [name, options] of Object.entries({ uninitialized: { emptyBaseline: true },
    partial: { migrationLimit: 1 }, differentSource: { sourceDrift: true }, current: {} })) {
    await t.test(name, async t => {
      const f = fixture(t, { reviewedCensus: true, ...options });
      if (name !== 'current') {
        await assert.rejects(f.census(), censusError);
        assert.deepEqual(f.calls, options.sourceDrift ? [] : ['', '/query']);
        return;
      }
      for (const [introduce, revert] of [
        ['CREATE TABLE unrelated (value TEXT)', 'DROP TABLE unrelated'],
        ['CREATE TABLE _cf_KV (key TEXT)', 'DROP TABLE _cf_KV'],
        ['CREATE INDEX extra_index ON drive_sessions (expires_at)', 'DROP INDEX extra_index'],
        ["UPDATE d1_migrations SET name = 'unreviewed.sql' WHERE id = 1",
          "UPDATE d1_migrations SET name = '0001_identity.sql' WHERE id = 1"],
        ["INSERT INTO sqlite_sequence VALUES ('other', 1)", "DELETE FROM sqlite_sequence WHERE name = 'other'"],
      ]) {
        f.sql(introduce);
        await assert.rejects(f.census(), censusError);
        f.sql(revert);
      }
      assert.deepEqual(await f.census(), { complete: true, items: [] });
      f.sql('ALTER TABLE drive_webauthn_challenges ADD COLUMN schema_drift TEXT');
      await assert.rejects(f.census(), censusError);
      f.sql('DROP TABLE drive_webauthn_challenges');
      await assert.rejects(f.census(), censusError);
      f.sql('CREATE VIEW drive_webauthn_challenges AS SELECT 1 WHERE 0');
      await assert.rejects(f.census(), censusError);
    });
  }
});

test('app table census rejects ambiguous or incomplete provider readback and honors abort', async t => {
  const f = fixture(t, { reviewedCensus: true });
  await assert.rejects(f.census({ signal: AbortSignal.abort() }), censusError);
  await assert.rejects(f.census({ transport: null }), censusError);
  await assert.rejects(f.census({ scope: { ...censusScope, database: 'unknown' } }), censusError);
  await assert.rejects(f.census({ patch: { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) } }), censusError);
  assert.deepEqual(f.calls, []);

  f.intercept(() => ok({ uuid: databaseId, name: 'unknown', version: 'production' }));
  await assert.rejects(f.census(), censusError);
  assert.deepEqual(f.calls.splice(0), ['']);

  for (const distort of [
    response => new Response(response.body, { status: 206 }),
    response => new Response(response.body, { headers: { 'Content-Range': 'bytes 0-79/200' } }),
    response => new Response(response.body, { headers: { 'Content-Length': '65536' } }),
    response => new Response(response.body, { headers: { Link: '</next>; rel="next"' } }),
    async response => new Response((await response.text()).slice(0, -1)),
    async response => new Response(`${await response.text()}${' '.repeat(65_536)}`),
    async response => new Response((await response.text()).replace('"success":true', '"succ\\u0065ss":false,"success":true')),
    async response => Response.json({ ...await response.json(), result_info: {} }),
    async response => Response.json({ ...await response.json(), messages: ['partial'] }),
    async response => { const { result } = await response.json(); return ok([result[0], result[0]]); },
    async response => { const { result } = await response.json(); result[0].results.pop(); return ok(result); },
    async response => { const { result } = await response.json(); result[0].meta = { truncated: true }; return ok(result); },
  ]) {
    f.intercept((path, _, run) => path === '/query' ? distort(run()) : run());
    await assert.rejects(f.census(), censusError);
  }

  const abort = new AbortController();
  f.intercept(async (path, init, run) => {
    const response = run();
    if (path === '/query') {
      await Promise.resolve();
      abort.abort();
      assert.equal(init.signal.aborted, true);
    }
    return response;
  });
  await assert.rejects(f.census({ signal: abort.signal }), censusError);
});

test('migration fixture census refuses either kind of residue from earlier attempts without exposing rows', async t => {
  const f = fixture(t);
  assert.equal(await f.inspect(), true);
  f.seed([other[0], 'drive-qualification/full-v0-other/17/1/', 'unrelated/', `${prefix}decoy/`,
    'drive-qualification/full-v0/17/02/', 'drive-qualification/full-v0/17x/2/',
    `drive-qualification/full-v0/${'1'.repeat(21)}/2/`]);
  const censusError = error => {
    assert.equal(error.message, 'Staging D1 migration fixture absence is unverified.');
    assert.equal(error.cause, undefined);
    return true;
  };
  f.sql('UPDATE drive_invitations SET redeemed_at = 5 WHERE id = ?', invite(other[0]));
  // Leave only invitation residue from the previous attempt.
  f.sql('DELETE FROM drive_bound_ceremonies WHERE context = ?', ceremony(other[0]));
  await assert.rejects(f.inspect(), censusError);
  assert.equal(f.sql('SELECT redeemed_at FROM drive_invitations WHERE id = ?', invite(other[0]))[0].redeemed_at, 5);
  f.sql('DELETE FROM drive_invitations WHERE id = ?', invite(other[0]));
  assert.equal(await f.inspect(), true); // unrelated and decoy keys remain
  f.sql(`INSERT INTO drive_bound_ceremonies (context, purpose, challenge, expires_at, principal_id, webauthn_user_handle)
    VALUES (?, 'registration', 'previous', 10, 'fixture-principal', 'handle')`, ceremony(other[0]));
  await assert.rejects(f.inspect(), censusError);
  assert.deepEqual(f.calls, Array.from({ length: 4 }, () => ['', '/query']).flat());
});

test('migration fixture census requires the protected source, pinned D1 and one complete numeric verdict', async t => {
  const f = fixture(t);
  const censusError = /D1 migration fixture absence is unverified/;
  await assert.rejects(f.inspect({ GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }), censusError);
  await assert.rejects(f.inspect({}, AbortSignal.abort()), censusError);
  assert.deepEqual(f.calls, []);
  f.intercept(() => ok({ uuid: databaseId, name: 'unknown', version: 'production' }));
  await assert.rejects(f.inspect(), censusError);
  assert.deepEqual(f.calls.splice(0), ['']);
  const zero = { invite_present: 0, ceremony_present: 0 };
  for (const rows of [[], [zero, zero], [{ ...zero, invite_present: '0' }], [{ invite_present: 0 }]]) {
    f.intercept((path, _, run) => path === '/query' ? ok([{ success: true, results: rows }]) : run());
    await assert.rejects(f.inspect(), censusError);
  }
  f.intercept((path, _, run) => {
    const response = run();
    if (path === '/query') response.headers.set('Content-Range', 'bytes 0-79/200');
    return response;
  });
  await assert.rejects(f.inspect(), censusError);
  f.intercept((path, _, run) => path === '/query' ? Response.json({ success: true, errors: [],
    result: [{ success: true, results: [zero] }], result_info: { cursor: 'next' } }) : run());
  await assert.rejects(f.inspect(), censusError);
  f.intercept((_, __, run) => run());
  f.sql('DROP TABLE drive_bound_ceremonies');
  await assert.rejects(f.inspect(), censusError);
  assert.deepEqual(f.calls, Array.from({ length: 7 }, () => ['', '/query']).flat());
});

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

test('recovery verifies either native POST bookmark form with a present or absent historical ledger', async t => {
  for (const [emptyBaseline, echoTarget] of [[false, true], [false, false], [true, true], [true, false]]) {
    const f = fixture(t, { emptyBaseline, echoTarget });
    f.sql('CREATE TABLE interrupted_migration (id INTEGER)');
    if (emptyBaseline) f.sql('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
    f.sql("INSERT INTO d1_migrations VALUES (999, 'interrupted.sql', '2026-11-20 11:00:00')");
    assert.deepEqual(await f.recover(), { status: 'restored' });
    assert.deepEqual(f.calls, ['', '/time_travel/bookmark', restore, '/time_travel/bookmark', '/query',
      ...(emptyBaseline ? [] : ['/query']), '/time_travel/bookmark']);
    assert.deepEqual(f.sql("SELECT name FROM sqlite_schema WHERE name = 'interrupted_migration'"), []);
    if (!emptyBaseline) assert.deepEqual(f.sql('SELECT id, name, applied_at FROM d1_migrations ORDER BY id'), f.historical);
    await assert.rejects(f.recover(), recoveryError);
    assert.deepEqual(f.calls.slice(-2), ['', '/time_travel/bookmark']);
  }
});

test('restore acknowledgement with result_info still requires independent bookmark and ledger readback', async t => {
  const f = fixture(t);
  f.intercept(async (path, _, run) => {
    const response = run();
    if (path !== restore) return response;
    return Response.json({ ...await response.json(), result_info: {} });
  });
  assert.deepEqual(await f.recover(), { status: 'restored' });
  assert.deepEqual(f.calls, ['', '/time_travel/bookmark', restore, '/time_travel/bookmark', '/query', '/query',
    '/time_travel/bookmark']);
});

test('recovery requires an absent ledger to stay absent regardless of table name casing', async t => {
  const f = fixture(t, { emptyBaseline: true });
  f.intercept((path, _, run) => {
    const result = run();
    if (path === restore) f.sql('CREATE TABLE D1_MIGRATIONS (id INTEGER)');
    return result;
  });
  await assert.rejects(f.recover(), recoveryError);
  assert.equal(f.calls.at(-1), '/query');
});

test('recovery refuses a bookmark advanced during final ledger readback, even if the ledger matches', async t => {
  for (const emptyBaseline of [false, true]) {
    const f = fixture(t, { emptyBaseline });
    const finalQuery = emptyBaseline ? 'FROM sqlite_schema' : 'FROM d1_migrations';
    let advanced = false;
    f.intercept((path, init, run) => {
      if (path === '/time_travel/bookmark' && advanced) return ok({ bookmark: '04-superseding' });
      const result = run();
      if (path === '/query' && init.body.includes(finalQuery)) advanced = true;
      return result;
    });
    await assert.rejects(f.recover(), recoveryError, `emptyBaseline=${emptyBaseline}`);
    assert.deepEqual(f.calls.slice(-2), ['/query', '/time_travel/bookmark']);
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
  for (const fault of ['lost', 'mismatch', 'bad-post', 'bad-undo', 'unchanged', 'bad-head', 'rewritten']) {
    const f = fixture(t);
    f.intercept((path, _, run) => {
      if (path === '/time_travel/bookmark' && f.calls.includes(restore) && fault === 'bad-head') return ok({ bookmark: '' });
      if (path !== restore) return run();
      if (fault === 'unchanged') return ok({ bookmark: f.proof.bookmark, previous_bookmark: '02-undo-point' });
      const result = run();
      if (fault === 'lost') throw new Error('synthetic lost response');
      if (fault === 'mismatch' || fault === 'bad-post') return ok({ bookmark: fault === 'mismatch' ? '04-other' : '', previous_bookmark: '02-undo-point' });
      if (fault === 'bad-undo') return ok({ bookmark: f.proof.bookmark, previous_bookmark: '' });
      if (fault === 'rewritten') f.sql("UPDATE d1_migrations SET applied_at = '2026-11-20 22:00:00' WHERE id = 1");
      return result;
    });
    await assert.rejects(f.recover(), recoveryError, fault);
    assert.deepEqual(f.calls, ['', '/time_travel/bookmark', restore,
      ...(['mismatch', 'unchanged', 'bad-head', 'rewritten'].includes(fault) ? ['/time_travel/bookmark'] : []),
      ...(fault === 'rewritten' ? ['/query', '/query'] : [])], fault);
  }
});
