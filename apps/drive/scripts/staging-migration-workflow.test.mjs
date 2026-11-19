import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

test('preparation has no staging credentials or live mutation step', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-preparation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\n  publish:\n(?:    #[^\n]*\n)*    if: \$\{\{ false \}\}/);
  assert.match(workflow, /- name: Record staging migration and rollback evidence\n(?:        #[^\n]*\n)*        if: \$\{\{ false \}\}/);
  assert.doesNotMatch(workflow, /\benvironment:|\bsecrets\b\s*(?:\.|\[)|CLOUDFLARE_API_TOKEN|staging-publish\.mjs|\bwrangler deploy\b/);
  assert.match(workflow, /\nconcurrency:\n  group: drive-staging-lifecycle\n  cancel-in-progress: false/);
  assert.match(workflow, /on:\n  workflow_dispatch:\n/);
});

test('workflow rejects mismatched source, SHA and checkout', (t) => {
  const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-preparation.yml', import.meta.url), 'utf8');
  const step = workflow.split('      - name: Verify staging source\n')[1]?.split('      - uses: actions/setup-node@')[0];
  assert.ok(step);
  const script = step.split('        run: |\n')[1];
  assert.ok(script);
  const root = mkdtempSync(join(tmpdir(), 'drive-grant-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = join(root, 'git');
  writeFileSync(git, '#!/bin/sh\nprintf "%s\\n" "$FAKE_CHECKOUT_SHA"\n');
  chmodSync(git, 0o700);
  const sha = 'a'.repeat(40);
  const env = { PATH: `${root}:/usr/bin:/bin`, GITHUB_REPOSITORY: 'TogetherWeOwn/qerith',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: sha, FAKE_CHECKOUT_SHA: sha };
  const check = (overrides) => spawnSync('/bin/bash', ['-c', script], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(check({}).status, 0);
  for (const overrides of [
    { GITHUB_REPOSITORY: 'togetherweown/qerith' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/other' }, { GITHUB_SHA: 'A'.repeat(40) },
    { FAKE_CHECKOUT_SHA: 'b'.repeat(40) },
  ]) {
    assert.notEqual(check(overrides).status, 0, JSON.stringify(overrides));
  }
});

function migrationFixture(t) {
  const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-preparation.yml', import.meta.url), 'utf8');
  const step = workflow.split('      - name: Record staging migration and rollback evidence\n')[1]
    ?.split('      - name: Publish built staging Worker')[0];
  const script = step?.split('        run: |\n')[1];
  assert.ok(script);
  const root = mkdtempSync(join(tmpdir(), 'drive-migrations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  const wrangler = join(root, 'node_modules/.bin/wrangler');
  writeFileSync(wrangler, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
if [ "${'${HANG_IGNORE_TERM:-}'}" = 1 ]; then trap '' TERM; while :; do :; done; fi
if [ "${'${CHILD_MODE:-}'}" != '' ]; then
  (sleep 2; printf escaped > "$CHILD_MARKER") &
  if [ "$CHILD_MODE" = overflow ]; then /usr/bin/yes x | /usr/bin/head -c 100000; fi
  wait
fi
case "$*" in
  *time-travel*) printf '%s\\n' "$BOOKMARK_RESPONSE" ;;
  *'migrations list'*)
    printf '%s\\n' "\${ERROR_OUTPUT:-}" >&2
    if grep -q 'migrations apply' "$CALLS"; then
      printf '%s\\n' "$AFTER_LIST"
    else
      printf '%s\\n' "$BEFORE_LIST"
    fi ;;
  *'migrations apply'*) if [ "\${LARGE_APPLY:-}" = 1 ]; then /usr/bin/head -c 150000 /dev/zero; fi; exit "\${APPLY_STATUS:-0}" ;;
esac
`);
  chmodSync(wrangler, 0o700);
  const calls = join(root, 'calls');
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: root, GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', CALLS: calls,
    BEFORE_LIST: '✅ No migrations to apply!', AFTER_LIST: '✅ No migrations to apply!',
    BOOKMARK_RESPONSE: '{"bookmark":"test-bookmark"}' };
  const run = (extra, shortenDeadline = false) => {
    writeFileSync(calls, '');
    return spawnSync('/bin/bash', ['-c', shortenDeadline ? script.replace(' 45s ', ' 1s ') : script], {
      cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000,
    });
  };
  return { root, run, calls: () => readFileSync(calls, 'utf8') };
}

test('migration workflow records the native ledger and fails closed on a pending post-list', (t) => {
  const { run, calls } = migrationFixture(t);
  const pending = 'Migrations to be applied:';
  const firstApply = run({ BEFORE_LIST: pending, LARGE_APPLY: '1' });
  assert.equal(firstApply.status, 0, firstApply.stderr);
  assert.match(firstApply.stdout, /test-bookmark/);
  assert.match(firstApply.stdout, /Pending migrations before apply:[\s\S]*Migrations to be applied:[\s\S]*Pending migrations after apply:[\s\S]*✅ No migrations to apply!/);
  assert.ok(firstApply.stdout.length < 65536, 'apply progress must not appear in the log');
  assert.doesNotMatch(firstApply.stdout, /\0/);
  assert.match(calls(), /d1 migrations apply qerith-drive-staging --remote --config wrangler\.staging\.json/);
  const stillPending = run({ AFTER_LIST: pending });
  assert.equal(stillPending.status, 1);
  assert.match(stillPending.stderr, /Migration apply or post-list failed/);
  assert.match(stillPending.stdout, /Pending migrations before apply:[\s\S]*✅ No migrations to apply![\s\S]*Pending migrations after apply:[\s\S]*Migrations to be applied:/);
  const guarded = run({ BEFORE_LIST: '::warning::untrusted output\n✅ No migrations to apply!' });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /::stop-commands::([a-f0-9]{64})\n::warning::untrusted output\n✅ No migrations to apply!\n\n::\1::/);
  assert.notEqual(run({ APPLY_STATUS: '1' }).status, 0);
  for (const response of ['sensitive-provider-text', '{}', '{"bookmark":""}', '{"bookmark":"bad\\nvalue"}']) {
    const result = run({ BOOKMARK_RESPONSE: response });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /sensitive-provider-text/);
    assert.doesNotMatch(calls(), /migrations apply/);
  }
});

test('migration capture terminates process groups on overflow and timeout', async (t) => {
  const { root, run, calls } = migrationFixture(t);
  const hung = run({ HANG_IGNORE_TERM: '1' }, true);
  assert.equal(hung.error, undefined, 'capture must kill a Wrangler process that ignores SIGTERM');
  assert.equal(hung.status, 1);
  assert.doesNotMatch(calls(), /migrations apply/);
  for (const mode of ['timeout', 'overflow']) {
    const marker = join(root, `child-${mode}`);
    const result = run({ CHILD_MODE: mode, CHILD_MARKER: marker }, mode === 'timeout');
    assert.equal(result.error, undefined, `${mode} must terminate the launcher and child`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Wrangler command or bounded capture failed/);
    assert.match(calls(), /time-travel info/);
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(existsSync(marker), false, `${mode} child survived capture`);
  }
  assert.equal(run({ BEFORE_LIST: 'x'.repeat(65536) }).status, 1);
  assert.doesNotMatch(calls(), /migrations apply/);
  const noisy = run({ ERROR_OUTPUT: 'z'.repeat(65536) });
  assert.equal(noisy.status, 1);
  assert.doesNotMatch(noisy.stderr, /z{20}/);
  assert.doesNotMatch(calls(), /migrations apply/);
});
