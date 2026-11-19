import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

test('publish job confines secrets to staging and gates publication on migration', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-preparation.yml', import.meta.url), 'utf8');
  const job = workflow.split('\n  publish:\n')[1];
  assert.ok(job);
  assert.match(job, /if: github\.repository == 'TogetherWeOwn\/qerith' && github\.ref == 'refs\/heads\/main' && github\.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(workflow.split('\n  publish:\n')[0], /secrets\./);
  assert.match(job, /\n    environment: staging/);
  assert.match(job, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.QERITH_STAGING_CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.ok(job.indexOf('Validate fixed staging target') < job.indexOf('Record staging migration and rollback evidence'));
  assert.match(job, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(job, /needs: preparation/);
  assert.match(workflow, /\nconcurrency:\n  group: drive-staging-lifecycle\n  cancel-in-progress: false/);
  assert.doesNotMatch(job, /DRIVE_STAGING_WRITE_GRANT/);
  assert.ok(job.indexOf('Verify staging source') < job.indexOf('Install and build exact source'));
  assert.ok(job.indexOf('Record staging migration and rollback evidence') < job.indexOf('Publish built staging Worker'));
  assert.match(job, /node scripts\/staging-publish\.mjs --publish/);
  assert.match(job, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.QERITH_STAGING_CLOUDFLARE_API_TOKEN \}\}/);
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

test('migration workflow records the native ledger and fails closed on a pending post-list', async (t) => {
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
  *'migrations list'*) printf '%s\\n' "\${ERROR_OUTPUT:-}" >&2; printf '%s\\n' "\${LIST_OUTPUT}" ;;
  *'migrations apply'*) if [ "\${LARGE_APPLY:-}" = 1 ]; then /usr/bin/head -c 150000 /dev/zero; fi; exit "\${APPLY_STATUS:-0}" ;;
esac
`);
  chmodSync(wrangler, 0o700);
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, RUNNER_TEMP: root, GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', CALLS: join(root, 'calls'),
    LIST_OUTPUT: '✅ No migrations to apply!', BOOKMARK_RESPONSE: '{"bookmark":"test-bookmark"}' };
  const run = (extra) => spawnSync('/bin/bash', ['-c', script], {
    cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000,
  });
  const hung = spawnSync('/bin/bash', ['-c', script.replace(' 45s ', ' 1s ')], {
    cwd: root, env: { ...env, HANG_IGNORE_TERM: '1' }, encoding: 'utf8', timeout: 5000,
  });
  assert.notEqual(hung.status, 0);
  assert.equal(hung.error, undefined, 'capture must kill a Wrangler process that ignores SIGTERM');
  assert.doesNotMatch(readFileSync(env.CALLS, 'utf8'), /migrations apply/);
  const ok = run({});
  assert.equal(ok.status, 0, ok.stderr);
  const firstApply = run({ LARGE_APPLY: '1' });
  assert.equal(firstApply.status, 0, firstApply.stderr);
  assert.ok(firstApply.stdout.length < 65536, 'apply progress must not appear in the log');
  assert.doesNotMatch(firstApply.stdout, /\0/);
  for (const mode of ['timeout', 'overflow']) {
    const marker = join(root, `child-${mode}`);
    const result = spawnSync('/bin/bash', ['-c', script.replace(' 45s ', ' 1s ')], {
      cwd: root, env: { ...env, CHILD_MODE: mode, CHILD_MARKER: marker }, encoding: 'utf8', timeout: 5000,
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined, `${mode} must terminate the launcher and child`);
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(existsSync(marker), false, `${mode} child survived capture`);
  }
  assert.match(ok.stdout, /test-bookmark/);
  const guarded = run({ LIST_OUTPUT: '::warning::untrusted output\n✅ No migrations to apply!' });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /::stop-commands::([a-f0-9]{64})\n::warning::untrusted output\n✅ No migrations to apply!\n\n::\1::/);
  assert.match(readFileSync(env.CALLS, 'utf8'), /d1 migrations apply qerith-drive-staging --remote --config wrangler\.staging\.json/);
  assert.notEqual(run({ LIST_OUTPUT: 'Migrations to be applied:' }).status, 0);
  assert.notEqual(run({ APPLY_STATUS: '1' }).status, 0);
  writeFileSync(env.CALLS, '');
  assert.notEqual(run({ LIST_OUTPUT: 'x'.repeat(65536) }).status, 0);
  assert.doesNotMatch(readFileSync(env.CALLS, 'utf8'), /migrations apply/);
  writeFileSync(env.CALLS, '');
  const noisy = run({ ERROR_OUTPUT: 'z'.repeat(65536) });
  assert.notEqual(noisy.status, 0);
  assert.doesNotMatch(noisy.stderr, /z{20}/);
  assert.doesNotMatch(readFileSync(env.CALLS, 'utf8'), /migrations apply/);
  for (const response of ['sensitive-provider-text', '{}', '{"bookmark":""}', '{"bookmark":"bad\\nvalue"}']) {
    writeFileSync(env.CALLS, '');
    const result = run({ BOOKMARK_RESPONSE: response });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /sensitive-provider-text/);
    assert.doesNotMatch(readFileSync(env.CALLS, 'utf8'), /migrations apply/);
  }
});
