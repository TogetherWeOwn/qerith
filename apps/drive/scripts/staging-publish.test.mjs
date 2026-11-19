import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishStaging as publish, validateStagingTarget } from './staging-publish.mjs';

const accountId = '209cf7dd678adfb683947dd7874d05af';
const publishStaging = (root, run) => publish(root, run, accountId);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'drive-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.svelte-kit/cloudflare'), { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(root, '.svelte-kit/cloudflare/_worker.js'), 'synthetic bundle');
  writeFileSync(join(root, 'node_modules/.bin/wrangler'), 'stub');
  const config = JSON.parse(readFileSync(new URL('../wrangler.staging.json', import.meta.url), 'utf8'));
  const save = () => writeFileSync(join(root, 'wrangler.staging.json'), JSON.stringify(config));
  save();
  return { root, config, save };
}

test('target validation rejects missing or wrong accounts before provider operations', (t) => {
  const { root } = fixture(t);
  assert.doesNotThrow(() => validateStagingTarget(root, accountId));
  for (const account of [null, '', '0'.repeat(32)]) {
    assert.throws(() => validateStagingTarget(root, account), /invalid staging Cloudflare account/);
    assert.throws(() => publish(root, () => assert.fail('runner invoked'), account), /invalid staging Cloudflare account/);
  }
});

test('target-check CLI validates the fixed account without invoking Wrangler', (t) => {
  const { root } = fixture(t);
  const script = new URL('./staging-publish.mjs', import.meta.url).pathname;
  const check = (account) => spawnSync(process.execPath, [script, '--check-target'], {
    cwd: root, env: { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: account }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(check(accountId).status, 0);
  assert.notEqual(check('0'.repeat(32)).status, 0);
});

test('publishes the validated staging bundle with the pinned runner', (t) => {
  const { root } = fixture(t);
  let called = 0;
  publishStaging(root, (binary, args, options) => {
    called++;
    assert.equal(binary, join(root, 'node_modules/.bin/wrangler'));
    assert.deepEqual(args, ['deploy', '.svelte-kit/cloudflare/_worker.js', '--config', 'wrangler.staging.json']);
    assert.equal(options.cwd, root);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.maxBuffer, 65536);
    assert.equal(options.timeout, 120000);
    assert.equal(options.killSignal, 'SIGKILL');
  });
  assert.equal(called, 1);
});

test('rejects missing and wrong inputs before invoking Wrangler', (t) => {
  const { root, config, save } = fixture(t);
  const never = () => assert.fail('runner invoked');
  config.name = 'qerith-drive'; save();
  assert.throws(() => publishStaging(root, never));
  config.name = 'qerith-drive-staging'; config.assets.directory = 'other'; save();
  assert.throws(() => publishStaging(root, never));
  config.assets.directory = '.svelte-kit/cloudflare'; save();
  rmSync(join(root, '.svelte-kit/cloudflare/_worker.js'));
  assert.throws(() => publishStaging(root, never));
  rmSync(join(root, 'wrangler.staging.json'));
  assert.throws(() => publishStaging(root, never));
});

test('rejects each mismatched staging configuration field', (t) => {
  const { root, config, save } = fixture(t);
  const never = () => assert.fail('runner invoked');
  for (const [object, key, value] of [
    [config, 'main', 'other.js'],
    [config, 'env', {}],
    [config, 'compatibility_date', '2025-01-01'],
    [config.d1_databases[0], 'binding', 'OTHER'],
    [config.d1_databases[0], 'database_name', 'production'],
    [config.d1_databases[0], 'database_id', 'other'],
    [config.d1_databases[0], 'migrations_dir', '../other'],
    [config.assets, 'binding', 'OTHER'],
    [config.assets, 'run_worker_first', false],
  ]) {
    const previous = object[key];
    object[key] = value;
    save();
    assert.throws(() => publishStaging(root, never), /invalid staging Worker configuration/);
    if (previous === undefined) delete object[key];
    else object[key] = previous;
  }
});

test('rejects unreviewed Wrangler fields before invoking the runner', (t) => {
  const { root, config, save } = fixture(t);
  const never = () => assert.fail('runner invoked');
  for (const [object, key, value] of [
    [config, 'routes', [{ pattern: 'example.com/*', zone_name: 'example.com' }]],
    [config, 'send_metrics', false],
    [config.d1_databases[0], 'preview_database_id', 'other'],
    [config.assets, 'not_found_handling', 'single-page-application'],
  ]) {
    object[key] = value;
    save();
    assert.throws(() => publishStaging(root, never), /invalid staging Worker configuration/);
    delete object[key];
  }
});

test('rejects a bundle symlink escaping the staging root', (t) => {
  const { root } = fixture(t);
  const entry = join(root, '.svelte-kit/cloudflare/_worker.js');
  rmSync(entry);
  symlinkSync('/dev/null', entry);
  assert.throws(() => publishStaging(root, () => assert.fail('runner invoked')), /invalid staging/);
});

test('command-line publisher refuses publication independently of the workflow', (t) => {
  const { root } = fixture(t);
  const script = new URL('./staging-publish.mjs', import.meta.url).pathname;
  const run = (args, account) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, env: { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: account }, encoding: 'utf8', timeout: 5000,
  });
  assert.match(run([], accountId).stderr, /unrecognized staging publisher arguments/);
  assert.match(run(['--publish'], accountId).stderr, /staging publication remains disabled/);
  assert.match(run(['--publish'], '0'.repeat(32)).stderr, /staging publication remains disabled/);
});

// Pin the complete reviewed source, including its comments, while publication is
// disabled. Re-review the entire workflow before changing this pin; do not just
// recompute it on failure. The enabling change must replace this temporary guard.
const disabledWorkflowSha256 = 'f38c4e9017d90400701ac1aa175b2f73e25ad95ec5d5e3aa6bddf1ec8184cf10';

/** @param {string | Buffer} workflow */
function assertDisabledStagingWorkflow(workflow) {
  assert.equal(createHash('sha256').update(workflow).digest('hex'), disabledWorkflowSha256,
    'staging preparation must match the reviewed disabled workflow');
}

const stagingWorkflow = () => readFileSync(
  new URL('../../../.github/workflows/drive-staging-preparation.yml', import.meta.url),
);

test('publish job remains disabled and bound to the preparation job and checkout SHA', () => {
  assertDisabledStagingWorkflow(stagingWorkflow());
});

test('disabled workflow rejects environment and secret changes independently', () => {
  const workflow = stagingWorkflow().toString('utf8');
  const withJobLine = (line) => workflow.replace('\n  publish:\n', `\n  publish:\n    ${line}\n`);
  assert.throws(() => assertDisabledStagingWorkflow(withJobLine('environment: staging')), /reviewed disabled workflow/);
  assert.throws(() => assertDisabledStagingWorkflow(withJobLine('env: { TOKEN: "${{ secrets.PLACEHOLDER }}" }')),
    /reviewed disabled workflow/);
});

test('normalizes publish failure without exposing provider diagnostics', (t) => {
  const { root } = fixture(t);
  assert.throws(() => publishStaging(root, () => { throw new Error('sensitive provider output'); }),
    { message: 'staging Worker publication failed' });
});
