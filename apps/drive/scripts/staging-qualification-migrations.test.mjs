import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyQualificationMigrations } from './staging-qualification-migrations.mjs';

const first = { id: 1, name: '0001_first.sql', applied_at: '2026-11-20 10:00:00' };
const second = { id: 2, name: '0002_second.sql', applied_at: '2026-11-20 10:02:00' };
const rows = (...results) => JSON.stringify([{ success: true, results }]);

function fixture(t, { localWrangler = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drive-qualification-d1-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'apps/drive');
  for (const dir of ['migrations', 'node_modules/.bin']) {
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
  if (localWrangler) {
    const binary = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));
    writeFileSync(join(root, 'local-wrangler'), `${binary}\n`);
  }
  writeFileSync(join(app, 'node_modules/.bin/wrangler'), `#!/bin/sh
printf '%s\n' "$*" >> "$HOME/calls"
if env | grep -Eq '^(QERITH_S3_|GITHUB_TOKEN=|NODE_OPTIONS=)'; then exit 70; fi
[ "$WRANGLER_WRITE_LOGS" = false ] && [ "$WRANGLER_SEND_METRICS" = false ] || exit 72
case "$*" in
  'd1 time-travel info '*) /bin/cat "$HOME/bookmark" ;;
  'd1 execute '*)
    if grep -q 'migrations apply' "$HOME/calls"; then /bin/cat "$HOME/after"; else /bin/cat "$HOME/before"; fi ;;
  'd1 migrations list '*)
    if [ -f "$HOME/local-wrangler" ]; then
      IFS= read -r wrangler < "$HOME/local-wrangler" || exit 76
      env -i "PATH=$PATH" "HOME=$HOME" CI=true NO_COLOR=1 WRANGLER_SEND_METRICS=false WRANGLER_WRITE_LOGS=false \\
        "$wrangler" d1 migrations list qerith-drive-staging --local --config wrangler.staging.json > "$HOME/local-list"
    fi ;;
  'd1 migrations apply '*)
    [ "$PWD" != "$HOME/apps/drive" ] || exit 73
    grep -qx 'SELECT 1;' migrations/${second.name} || exit 74
    grep -q '"database_id":"87ac8041-ad2d-4650-b0d7-05bb78846f60"' wrangler.staging.json || exit 75
    if [ -f "$HOME/fail-apply" ]; then printf '%s\\n' 'sensitive-provider-diagnostic' >&2; exit 2; fi ;;
  *) exit 71 ;;
esac
`, { mode: 0o700 });
  const env = { PATH: localWrangler ? `${dirname(process.execPath)}:/usr/bin:/bin` : '/usr/bin:/bin',
    HOME: root, CLOUDFLARE_API_TOKEN: 'synthetic',
    CLOUDFLARE_ACCOUNT_ID: '209cf7dd678adfb683947dd7874d05af', GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/drive-staging-qualification.yml@refs/heads/main',
    GITHUB_JOB: 'qualification', GITHUB_REPOSITORY: 'TogetherWeOwn/qerith', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', TESTED_SHA: sha, GITHUB_SHA: sha, GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_TOKEN: 'synthetic', QERITH_S3_SECRET_ACCESS_KEY: 'synthetic', NODE_OPTIONS: 'synthetic' };
  const file = (name, contents) => writeFileSync(join(app, name), contents);
  const calls = () => readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').filter(Boolean);
  const run = ({ overrides, bookmark = '{"bookmark":"bookmark-17"}', before = rows(first),
    after = rows(first, second), signal, recordRecovery = () => {} } = {}) => {
    for (const [name, text] of Object.entries({ calls: '', bookmark, before, after })) writeFileSync(join(root, name), text);
    return applyQualificationMigrations({ recordRecovery }, { ...env, ...overrides }, relative(process.cwd(), root), signal);
  };
  return { app, sha, file, calls, run, failApply: () => writeFileSync(join(root, 'fail-apply'), ''),
    localList: () => readFileSync(join(root, 'local-list'), 'utf8') };
}

const target = 'qerith-drive-staging';
const config = '--config wrangler.staging.json';
const bookmarkCommand = `d1 time-travel info ${target} --json ${config}`;
const list = `d1 migrations list ${target} --remote ${config}`;
const ledger = `d1 execute ${target} --remote --json --command SELECT id, name, applied_at FROM d1_migrations ORDER BY id ${config}`;
const apply = `d1 migrations apply ${target} --remote ${config}`;

test('records the exact-attempt bookmark before mutation and returns the complete native ledger', async t => {
  const { sha, calls, run } = fixture(t);
  const recordRecovery = t.mock.fn(point => {
    assert.deepEqual(point, { sha, runId: '17', attempt: '2', bookmark: 'bookmark-17' });
    assert.deepEqual(calls(), [bookmarkCommand]);
  });
  assert.deepEqual(await run({ recordRecovery }), { sha, runId: '17', attempt: '2', bookmark: 'bookmark-17',
    before: [first], after: [first, second] });
  assert.equal(recordRecovery.mock.callCount(), 1);
  assert.deepEqual(calls(), [bookmarkCommand, list, ledger, apply, ledger]);
});

test('does not initialize the ledger while the recovery writer is pending or after it rejects', async t => {
  const { calls, run } = fixture(t);
  const entered = Promise.withResolvers();
  const writer = Promise.withResolvers();
  const recordRecovery = () => { entered.resolve(); return writer.promise; };
  const outcome = assert.rejects(run({ recordRecovery }), /recovery write failed/);
  await Promise.race([entered.promise, outcome]);
  assert.deepEqual(calls(), [bookmarkCommand]);
  writer.reject(new Error('recovery write failed'));
  await outcome;
  assert.deepEqual(calls(), [bookmarkCommand]);
});

test('uses the private SQL and config even if the checkout changes after validation', async t => {
  const { file, calls, run } = fixture(t);
  const result = await run({ recordRecovery() {
    file(`migrations/${second.name}`, 'SELECT 2;\n');
    file('wrangler.staging.json', '{}');
    assert.deepEqual(calls(), [bookmarkCommand]);
  } });
  assert.deepEqual(result.after, [first, second]);
  assert.deepEqual(calls(), [bookmarkCommand, list, ledger, apply, ledger]);
  await assert.rejects(run(), /migration config differs/);
  assert.deepEqual(calls(), []);
});

test('pinned Wrangler resolves both private migrations in local mode', {
  skip: process.env.DRIVE_QUALIFICATION_WRANGLER_LOCAL !== '1',
}, async t => {
  const { file, localList, run } = fixture(t, { localWrangler: true });
  await run({ recordRecovery() { file('wrangler.staging.json', '{}'); } });
  const output = localList();
  for (const { name } of [first, second]) assert.ok(output.includes(name), `Missing ${name} in the local Wrangler list`);
});

test('rejects wrong dispatch, target, untracked migrations and changed migration bytes before Wrangler', async t => {
  const { app, file, calls, run } = fixture(t);
  for (const overrides of [{ GITHUB_JOB: 'publish' }, { TESTED_SHA: 'b'.repeat(40) },
    { GITHUB_RUN_ATTEMPT: '02' }, { GITHUB_RUN_ID: 17 }, { GITHUB_WORKFLOW_REF: 'other' },
    { CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) }]) {
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
  await assert.rejects(run({
    after: rows({ ...first, applied_at: '2026-11-20 10:01:00' }, second),
  }), /post-apply ledger is incomplete or changed history/);
  assert.deepEqual(calls(), [bookmarkCommand, list, ledger, apply, ledger]);
});

test('does not return evidence after failed apply, incomplete ledger or rewritten history', async t => {
  const { failApply, calls, run } = fixture(t);
  for (const after of [rows(first), rows({ ...first, id: 2 }, { ...second, id: 3 }), '[]']) {
    await assert.rejects(run({ after }), /ledger/);
    assert.deepEqual(calls(), [bookmarkCommand, list, ledger, apply, ledger]);
  }
  failApply();
  await assert.rejects(run(), { message: 'Bounded staging D1 command failed.' });
  assert.deepEqual(calls(), [bookmarkCommand, list, ledger, apply]);
});
