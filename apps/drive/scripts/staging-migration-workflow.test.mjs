import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-preparation.yml', import.meta.url), 'utf8');
const storageStep = '      - name: Verify staging storage qualification before migration\n';
const migrationStep = '      - name: Migrate staging D1\n';
const publishStep = '      - name: Publish staging Worker\n';
const emptyList = 'Resource location: remote \n\n✅ No migrations to apply!';
const [before, protectedSteps] = workflow.split(storageStep);
const [preflight, afterPreflight] = protectedSteps.split(migrationStep);
const [migration, publish] = afterPreflight.split(publishStep);
const storageEnv = { QERITH_S3_ENDPOINT: 'https://storage.example.test/', QERITH_S3_BUCKET: 'fixture', QERITH_S3_REGION: 'auto',
  QERITH_S3_STORAGE_EPOCH: 'test-epoch', QERITH_S3_ACCESS_KEY_ID: 'test-access-key', QERITH_S3_SECRET_ACCESS_KEY: 'test-secret-key' };

test('staging credentials stay in their main-only protected steps', () => {
  assert.match(workflow, /\non:\n  workflow_dispatch:\n\npermissions:/);
  assert.match(workflow, /\nconcurrency:\n  group: drive-staging-lifecycle\n  cancel-in-progress: false/);
  assert.doesNotMatch(before, /\bsecrets\b\s*(?:\.|\[)|CLOUDFLARE_API_TOKEN/);
  assert.match(before, /\n  publish:\n    if: github\.repository == 'TogetherWeOwn\/qerith' && github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\n    needs: preparation\n    environment: staging\n/);
  assert.match(before.split('\n  publish:\n')[1], /ref: \$\{\{ github\.sha \}\}\n          persist-credentials: false/);
  assert.match(before, /npm run build\n      - name: Dry-run the staging Worker package before migration\n[\s\S]*wrangler deploy[\s\S]*--config wrangler\.staging\.json --dry-run/);
  const mapping = step => [...step.matchAll(/^\s+(\w+): \$\{\{ secrets\.(\w+) \}\}$/gm)].map(match => match.slice(1));
  const deploySecrets = [
    ['CLOUDFLARE_ACCOUNT_ID', 'QERITH_STAGING_CLOUDFLARE_ACCOUNT_ID'],
    ['CLOUDFLARE_API_TOKEN', 'QERITH_STAGING_CLOUDFLARE_API_TOKEN'],
    ['DRIVE_OWNER_ENROLLMENT', 'QERITH_STAGING_OWNER_ENROLLMENT'],
  ];
  const storageSecrets = Object.keys(storageEnv).map(name => [name, name]);
  assert.deepEqual(mapping(preflight), storageSecrets);
  assert.deepEqual(mapping(migration), deploySecrets);
  assert.deepEqual(mapping(publish), [...deploySecrets, ...storageSecrets]);
  assert.match(migration, /unset DRIVE_OWNER_ENROLLMENT[\s\S]*DRIVE_OWNER_ENROLLMENT="\$enrollment" node scripts\/staging-publish\.mjs --check-target/);
  assert.doesNotMatch(workflow, /DRIVE_ORIGIN|DRIVE_SIGN_IN_FIXTURE|continue-on-error|always\(\)/);
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
  const script = migration.split('        run: |\n')[1];
  const preflightCommand = preflight.split('        run: ')[1]?.trim();
  const publishCommand = publish.split('        run: ')[1]?.trim();
  assert.equal(preflightCommand, 'node scripts/staging-publish.mjs --check-storage');
  assert.equal(publishCommand, 'node scripts/staging-publish.mjs --publish');
  assert.ok(script);
  const root = mkdtempSync(join(tmpdir(), 'drive-migrations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['node_modules/.bin', 'scripts', '.svelte-kit/cloudflare', 'src/lib/server/s3']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  copyFileSync(new URL('./staging-publish.mjs', import.meta.url), join(root, 'scripts/staging-publish.mjs'));
  const validator = 'src/lib/server/s3/config.ts';
  copyFileSync(new URL(`../${validator}`, import.meta.url), join(root, validator));
  const storageConfigId = JSON.stringify(['https://storage.example.test', 'fixture', 'test-epoch']);
  const identitySha256 = createHash('sha256').update(JSON.stringify([storageConfigId, 'auto', 'test-access-key'])).digest('hex');
  const receipt = { version: 1, sourceSha: 'b'.repeat(40), runId: '42', runAttempt: 1, completionTimeoutMs: 3000,
    passed: true, failures: [], cleanup: 'verified', scope: { identitySha256, policySha256: 'c'.repeat(64) } };
  const saveReceipt = (extra = {}) => writeFileSync(join(root, 'scripts/staging-storage-qualification.json'), JSON.stringify({ ...receipt, ...extra }));
  saveReceipt();
  copyFileSync(new URL('../wrangler.staging.json', import.meta.url), join(root, 'wrangler.staging.json'));
  writeFileSync(join(root, '.svelte-kit/cloudflare/_worker.js'), 'synthetic bundle');
  const wrangler = join(root, 'node_modules/.bin/wrangler');
  writeFileSync(wrangler, `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
if env | grep -q '^QERITH_S3_'; then exit 90; fi
if [ "$1" = deploy ]; then
  [ "$3" = --config ] && [ "$7" = --secrets-file ] || exit 91
  [ "$(stat -c %a "$4")" = 600 ] && [ "$(stat -c %a "$8")" = 600 ] || exit 92
  cp "$4" "$RUNNER_TEMP/publish-config" && cp "$8" "$RUNNER_TEMP/publish-secrets" || exit 93
fi
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
  const step = (command, stepEnv) => spawnSync('/bin/bash', ['-e', '-c', command], {
    cwd: root, env: stepEnv, encoding: 'utf8', timeout: 5000,
  });
  const run = (extra, storage = storageEnv) => {
    writeFileSync(calls, '');
    const checked = step(preflightCommand, { PATH: env.PATH, ...storage });
    if (checked.status !== 0) return checked;
    const command = extra.CHILD_MODE === 'timeout'
      ? script.replaceAll(' 45s ', ' 1s ').replace(' 120s ', ' 1s ')
      : script;
    const migrated = step(command, { ...env, ...extra });
    if (migrated.status !== 0) return migrated;
    const deployed = step(publishCommand, { ...env, ...extra, ...storage });
    return { ...deployed, stdout: migrated.stdout + deployed.stdout, stderr: migrated.stderr + deployed.stderr };
  };
  return { root, run, saveReceipt, storageConfigId, calls: () => readFileSync(calls, 'utf8') };
}

test('publishes only matching proof bindings and keeps signer credentials out of argv and config', (t) => {
  const { root, run, calls, storageConfigId } = migrationFixture(t);
  const result = run({});
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(join(root, 'publish-config'), 'utf8'));
  assert.equal(config.assets.directory, join(root, '.svelte-kit/cloudflare'));
  assert.equal(config.main, join(root, '.svelte-kit/cloudflare/_worker.js'));
  assert.equal(config.d1_databases[0].binding, 'DB');
  assert.deepEqual(config.vars, {
    DRIVE_S3_ENDPOINT: 'https://storage.example.test', DRIVE_S3_BUCKET: 'fixture', DRIVE_S3_REGION: 'auto',
    DRIVE_S3_STORAGE_EPOCH: 'test-epoch', DRIVE_S3_QUALIFICATION: JSON.stringify({ version: 1, storageConfigId,
      region: 'auto', sourceSha: 'b'.repeat(40), runId: '42', runAttempt: 1, completionTimeoutMs: 3000 }),
  });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'publish-secrets'), 'utf8')), {
    DRIVE_S3_ACCESS_KEY_ID: 'test-access-key', DRIVE_S3_SECRET_ACCESS_KEY: 'test-secret-key',
  });
  assert.doesNotMatch(calls() + result.stdout + result.stderr, /storage\.example\.test|test-access-key|test-secret-key/);
  const args = calls().trim().split('\n').at(-1).split(' ');
  for (const index of [3, 7]) assert.equal(existsSync(args[index]), false);
});

test('stale, failed or incomplete storage proof stops before any migration or publish', (t) => {
  const { run, calls, saveReceipt } = migrationFixture(t);
  for (const [name, value] of Object.entries({ QERITH_S3_ENDPOINT: 'https://other.example.test', QERITH_S3_BUCKET: 'other',
    QERITH_S3_REGION: 'other', QERITH_S3_STORAGE_EPOCH: 'other', QERITH_S3_ACCESS_KEY_ID: 'other', QERITH_S3_SECRET_ACCESS_KEY: '' })) {
    const result = run({}, { ...storageEnv, [name]: value });
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /missing staging storage settings: QERITH_S3_SECRET_ACCESS_KEY|does not match a passing qualification/);
    assert.equal(calls(), '');
  }
  for (const overrides of [{ passed: false }, { cleanup: 'unverified' }, { completionTimeoutMs: 60001 }]) {
    saveReceipt(overrides);
    const result = run({});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match a passing qualification/);
    assert.equal(calls(), '');
  }
});

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
  const lines = calls().trim().split('\n');
  assert.deepEqual(lines.slice(0, -1), [
    `d1 migrations list ${target} --remote ${config}`,
    `d1 time-travel info ${target} --json ${config}`,
    `d1 migrations apply ${target} --remote ${config}`,
    `d1 migrations list ${target} --remote ${config}`,
  ]);
  assert.match(lines.at(-1), /^deploy .* --config .* --var DRIVE_OWNER_ENROLLMENT_RELEASE:disabled --secrets-file /);
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
  for (const [sha, expiry] of [['b'.repeat(40), Date.now() + 60_000], ['a'.repeat(40), 1000000000000]]) {
    const result = run({ DRIVE_OWNER_ENROLLMENT: `${sha}:${expiry}:${'a'.repeat(43)}` });
    assert.match(result.stderr, /invalid, mismatched or expired staging enrollment authorization/);
    assert.equal(calls(), '');
  }
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
