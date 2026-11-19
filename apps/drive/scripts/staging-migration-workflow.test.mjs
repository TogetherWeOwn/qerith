import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-preparation.yml', import.meta.url), 'utf8');
const publishStep = '      - name: Migrate and publish staging Worker\n';
const emptyList = 'Resource location: remote \n\n✅ No migrations to apply!';

test('staging credentials are scoped to the main-only dispatch mutation step', () => {
  assert.match(workflow, /\non:\n  workflow_dispatch:\n\npermissions:/);
  assert.match(workflow, /\nconcurrency:\n  group: drive-staging-lifecycle\n  cancel-in-progress: false/);
  const [before, mutation] = workflow.split(publishStep);
  assert.ok(mutation);
  assert.doesNotMatch(before, /\bsecrets\b\s*(?:\.|\[)|CLOUDFLARE_API_TOKEN/);
  assert.match(before, /\n  publish:\n    if: github\.repository == 'TogetherWeOwn\/qerith' && github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\n    needs: preparation\n    environment: staging\n/);
  const publish = before.split('\n  publish:\n')[1];
  assert.match(publish, /ref: \$\{\{ github\.sha \}\}\n          persist-credentials: false/);
  assert.match(publish, /npm run build\n      - name: Dry-run the staging Worker package before migration\n[\s\S]*wrangler deploy[\s\S]*--config wrangler\.staging\.json --dry-run/);
  assert.deepEqual([...mutation.matchAll(/^\s+(\w+): \$\{\{ secrets\.(\w+) \}\}$/gm)]
    .map(match => match.slice(1)), [
    ['CLOUDFLARE_ACCOUNT_ID', 'QERITH_STAGING_CLOUDFLARE_ACCOUNT_ID'],
    ['CLOUDFLARE_API_TOKEN', 'QERITH_STAGING_CLOUDFLARE_API_TOKEN'],
  ]);
  assert.equal([...mutation.matchAll(/\bsecrets\b\s*(?:\.|\[)/g)].length, 2);
});

test('workflow rejects mismatched source, SHA and checkout', (t) => {
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
  const script = workflow.split(publishStep)[1]?.split('        run: |\n')[1];
  assert.ok(script);
  const root = mkdtempSync(join(tmpdir(), 'drive-migrations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['node_modules/.bin', 'scripts', '.svelte-kit/cloudflare']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  copyFileSync(new URL('./staging-publish.mjs', import.meta.url), join(root, 'scripts/staging-publish.mjs'));
  copyFileSync(new URL('../wrangler.staging.json', import.meta.url), join(root, 'wrangler.staging.json'));
  writeFileSync(join(root, '.svelte-kit/cloudflare/_worker.js'), 'synthetic bundle');
  const wrangler = join(root, 'node_modules/.bin/wrangler');
  writeFileSync(wrangler, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
phase=other
case "$*" in
  *'migrations list'*)
    if grep -q 'migrations apply' "$CALLS"; then phase=after; else phase=before; fi ;;
  *'migrations apply'*) phase=apply ;;
esac
if [ "$phase" = "\${CHILD_PHASE:-}" ]; then
  if [ "$CHILD_MODE" = timeout ]; then trap '' TERM; fi
  (sleep 2; printf escaped > "$CHILD_MARKER") &
  if [ "$CHILD_MODE" = overflow ]; then
    if [ "$phase" = apply ]; then exec 1>&2; fi
    /usr/bin/yes x | /usr/bin/head -c 100000
  fi
  wait
fi
case "$*" in
  *time-travel*) printf '%s\\n' "$BOOKMARK_RESPONSE" ;;
  *'migrations list'*)
    printf '%s\\n' "\${ERROR_OUTPUT:-}" >&2
    if grep -q 'migrations apply' "$CALLS"; then
      printf '%s\\n' "$AFTER_LIST"
      exit "\${AFTER_STATUS:-0}"
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
    GITHUB_ACTIONS: 'true', GITHUB_JOB: 'publish', GITHUB_REPOSITORY: 'TogetherWeOwn/qerith',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    CLOUDFLARE_ACCOUNT_ID: '209cf7dd678adfb683947dd7874d05af', CLOUDFLARE_API_TOKEN: 'synthetic',
    BEFORE_LIST: emptyList, AFTER_LIST: emptyList, BOOKMARK_RESPONSE: '{"bookmark":"test-bookmark"}' };
  const run = (extra) => {
    writeFileSync(calls, '');
    const command = extra.CHILD_MODE === 'timeout'
      ? script.replaceAll(' 45s ', ' 1s ').replace(' 120s ', ' 1s ')
      : script;
    return spawnSync('/bin/bash', ['-c', command], {
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
  const target = 'qerith-drive-staging';
  const config = '--config wrangler.staging.json';
  assert.deepEqual(calls().trim().split('\n'), [
    `d1 migrations list ${target} --remote ${config}`,
    `d1 time-travel info ${target} --json ${config}`,
    `d1 migrations apply ${target} --remote ${config}`,
    `d1 migrations list ${target} --remote ${config}`,
    `deploy .svelte-kit/cloudflare/_worker.js ${config}`,
  ]);
  assert.ok(firstApply.stdout.indexOf('Pending migrations before apply:') < firstApply.stdout.indexOf('Pre-apply Time Travel bookmark:'));
  for (const after of [pending, `${emptyList}\n${pending}`, `${emptyList}\n✅ No migrations to apply!`,
    `${emptyList}\n│ 0033_pending.sql │`, emptyList.replace('remote', 'local')]) {
    const result = run({ AFTER_LIST: after });
    assert.equal(result.status, 1, after);
    assert.match(result.stderr, /Migration apply or post-list failed/);
    assert.ok(result.stdout.includes(after), 'the post-list was recorded');
    assert.doesNotMatch(calls(), /^deploy /m);
  }
  const guarded = run({ BEFORE_LIST: '::warning::untrusted output\n✅ No migrations to apply!' });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /::stop-commands::([a-f0-9]{64})\n::warning::untrusted output\n✅ No migrations to apply!\n\n::\1::/);
  for (const failure of [{ APPLY_STATUS: '1' }, { AFTER_STATUS: '1' }]) {
    assert.equal(run(failure).status, 1);
    assert.doesNotMatch(calls(), /^deploy /m);
  }
  for (const response of ['sensitive-provider-text', '{}', '{"bookmark":""}', '{"bookmark":"bad\\nvalue"}']) {
    const result = run({ BOOKMARK_RESPONSE: response });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /sensitive-provider-text/);
    assert.doesNotMatch(calls(), /migrations apply/);
  }
});

test('migration workflow refuses missing credentials or an unexpected account before Wrangler', (t) => {
  const { run, calls } = migrationFixture(t);
  assert.match(run({ CLOUDFLARE_API_TOKEN: '' }).stderr, /missing staging deploy token/);
  assert.equal(calls(), '');
  assert.match(run({ CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) }).stderr, /invalid staging Cloudflare account/);
  assert.equal(calls(), '');
});

test('migration capture terminates process groups on overflow and timeout', async (t) => {
  const { root, run, calls } = migrationFixture(t);
  for (const phase of ['before', 'apply', 'after']) {
    for (const mode of ['timeout', 'overflow']) {
      const label = `${phase}-${mode}`;
      const marker = join(root, `child-${label}`);
      const result = run({ CHILD_PHASE: phase, CHILD_MODE: mode, CHILD_MARKER: marker });
      assert.equal(result.error, undefined, `${label}: launcher and child must terminate`);
      assert.equal(result.status, 1, label);
      assert.match(result.stderr, /Wrangler command or bounded capture failed/);
      assert.match(calls(), /^d1 migrations list /);
      assert.doesNotMatch(calls(), /^deploy /m);
      if (phase === 'before') assert.doesNotMatch(calls(), /time-travel info|migrations apply/);
      else assert.equal((calls().match(/^d1 migrations list /gm) ?? []).length, 2);
      await new Promise(resolve => setTimeout(resolve, 2300));
      assert.equal(existsSync(marker), false, `${label}: child survived capture`);
    }
  }
  assert.equal(run({ BEFORE_LIST: 'x'.repeat(65536) }).status, 1);
  assert.doesNotMatch(calls(), /migrations apply/);
  const noisy = run({ ERROR_OUTPUT: 'z'.repeat(65536) });
  assert.equal(noisy.status, 1);
  assert.doesNotMatch(noisy.stderr, /z{20}/);
  assert.doesNotMatch(calls(), /migrations apply/);
});
