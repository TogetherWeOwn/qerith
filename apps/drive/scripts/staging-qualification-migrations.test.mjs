import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyQualificationMigrations } from './staging-qualification-migrations.mjs';

const first = { id: 1, name: '0001_first.sql', applied_at: '2026-11-20 10:00:00' };
const second = { id: 2, name: '0002_second.sql', applied_at: '2026-11-20 10:02:00' };
const rows = (...results) => JSON.stringify([{ success: true, results }]);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'drive-qualification-d1-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'apps/drive');
  for (const dir of ['migrations', '.svelte-kit/cloudflare', 'node_modules/.bin']) {
    mkdirSync(join(app, dir), { recursive: true });
  }
  const git = (...args) => execFileSync('/usr/bin/git', args, {
    cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  for (const { name } of [first, second]) writeFileSync(join(app, 'migrations', name), 'SELECT 1;\n');
  copyFileSync(new URL('../wrangler.staging.json', import.meta.url), join(app, 'wrangler.staging.json'));
  git('init', '-b', 'main');
  git('add', 'apps/drive/migrations', 'apps/drive/wrangler.staging.json');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  writeFileSync(join(app, '.svelte-kit/cloudflare/_worker.js'), 'fixture');
  writeFileSync(join(app, 'node_modules/.bin/wrangler'), `#!/bin/sh
printf '%s\n' "$*" >> calls
if env | grep -Eq '^(QERITH_S3_|GITHUB_TOKEN=|NODE_OPTIONS=)'; then exit 70; fi
[ "$WRANGLER_WRITE_LOGS" = false ] && [ "$WRANGLER_SEND_METRICS" = false ] || exit 72
case "$*" in
  'd1 time-travel info '*) /bin/cat bookmark ;;
  'd1 execute '*)
    if grep -q 'migrations apply' calls; then /bin/cat after; else /bin/cat before; fi ;;
  'd1 migrations list '*) : ;;
  'd1 migrations apply '*)
    if [ -f fail-apply ]; then printf '%s\\n' 'sensitive-provider-diagnostic' >&2; exit 2; fi ;;
  *) exit 71 ;;
esac
`, { mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin', HOME: root, CLOUDFLARE_API_TOKEN: 'synthetic',
    CLOUDFLARE_ACCOUNT_ID: '209cf7dd678adfb683947dd7874d05af', GITHUB_ACTIONS: 'true',
    GITHUB_JOB: 'qualification', GITHUB_REPOSITORY: 'TogetherWeOwn/qerith', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', TESTED_SHA: sha, GITHUB_SHA: sha, GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_TOKEN: 'synthetic', QERITH_S3_SECRET_ACCESS_KEY: 'synthetic', NODE_OPTIONS: 'synthetic' };
  const file = (name, contents) => writeFileSync(join(app, name), contents);
  const calls = () => readFileSync(join(app, 'calls'), 'utf8').trim().split('\n').filter(Boolean);
  const run = ({ overrides, bookmark = '{"bookmark":"bookmark-17"}', before = rows(first),
    after = rows(first, second), signal } = {}) => {
    for (const [name, text] of Object.entries({ calls: '', bookmark, before, after })) file(name, text);
    return applyQualificationMigrations({ ...env, ...overrides }, root, signal);
  };
  return { app, sha, file, calls, run };
}

const target = 'qerith-drive-staging';
const config = '--config wrangler.staging.json';
const bookmarkCommand = `d1 time-travel info ${target} --json ${config}`;
const list = `d1 migrations list ${target} --remote ${config}`;
const ledger = `d1 execute ${target} --remote --json --command SELECT id, name, applied_at FROM d1_migrations ORDER BY id ${config}`;
const apply = `d1 migrations apply ${target} --remote ${config}`;

test('records the exact-attempt bookmark before mutation and returns the complete native ledger', async t => {
  const { sha, calls, run } = fixture(t);
  const log = t.mock.method(console, 'log', message => {
    assert.match(message, new RegExp(`${sha}, run 17, attempt 2\\): bookmark-17$`));
    assert.deepEqual(calls(), [bookmarkCommand]);
  });
  assert.deepEqual(await run(), { sha, runId: '17', attempt: '2', bookmark: 'bookmark-17',
    before: [first], after: [first, second] });
  assert.equal(log.mock.callCount(), 1);
  assert.deepEqual(calls(), [bookmarkCommand, list, ledger, apply, ledger]);
});

test('rejects wrong dispatch, target, untracked migrations and changed migration bytes before Wrangler', async t => {
  const { app, file, calls, run } = fixture(t);
  for (const overrides of [{ GITHUB_JOB: 'publish' }, { TESTED_SHA: 'b'.repeat(40) },
    { GITHUB_RUN_ATTEMPT: '02' }, { CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) }]) {
    await assert.rejects(run({ overrides }));
    assert.deepEqual(calls(), []);
  }
  file('migrations/untracked.sql', 'SELECT 1;');
  await assert.rejects(run(), /Unexpected staging migration input/);
  assert.deepEqual(calls(), []);
  rmSync(join(app, 'migrations/untracked.sql'));
  file(`migrations/${second.name}`, 'SELECT 2;\n');
  await assert.rejects(run(), /migration bytes differ/);
  assert.deepEqual(calls(), []);
  rmSync(join(app, 'migrations', second.name));
  symlinkSync(first.name, join(app, 'migrations', second.name));
  await assert.rejects(run(), /migration bytes differ/);
  assert.deepEqual(calls(), []);
});

test('rejects invalid bookmarks, foreign ledger entries and cancellation before applying', async t => {
  const { calls, run } = fixture(t);
  t.mock.method(console, 'log', () => {});
  await assert.rejects(run({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.deepEqual(calls(), []);
  for (const bookmark of ['not-json', '{}', '{"bookmark":"inject\\ncommand"}', 'x'.repeat(65537)]) {
    await assert.rejects(run({ bookmark }));
    assert.deepEqual(calls(), [bookmarkCommand]);
  }
  for (const before of [rows({ ...first, name: 'foreign.sql' }), rows(first, { ...first, id: 2 }),
    rows({ ...first, applied_at: undefined }), rows({ ...first, applied_at: 'invalid' }), '[{"success":false,"results":[]}]']) {
    await assert.rejects(run({ before }), /staging D1 migration ledger/);
    assert.deepEqual(calls(), [bookmarkCommand, list, ledger]);
  }
});

test('rejects a changed historical application timestamp', async t => {
  const { calls, run } = fixture(t);
  t.mock.method(console, 'log', () => {});
  await assert.rejects(run({
    after: rows({ ...first, applied_at: '2026-11-20 10:01:00' }, second),
  }), /post-apply ledger is incomplete or changed history/);
  assert.deepEqual(calls(), [bookmarkCommand, list, ledger, apply, ledger]);
});

test('does not return evidence after failed apply, incomplete ledger or rewritten history', async t => {
  const { file, calls, run } = fixture(t);
  t.mock.method(console, 'log', () => {});
  for (const after of [rows(first), rows({ ...first, id: 2 }, { ...second, id: 3 }), '[]']) {
    await assert.rejects(run({ after }), /ledger/);
    assert.deepEqual(calls(), [bookmarkCommand, list, ledger, apply, ledger]);
  }
  file('fail-apply', '');
  await assert.rejects(run(), { message: 'Bounded staging D1 command failed.' });
  assert.deepEqual(calls(), [bookmarkCommand, list, ledger, apply]);
});
