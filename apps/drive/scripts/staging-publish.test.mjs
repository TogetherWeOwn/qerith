import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

// Pin this final job until a separately reviewed enabling change. Comparing the
// whole body rejects new YAML keys or values without trying to parse expressions.
const disabledPublishJob = `    if: \${{ false }}
    needs: preparation
    concurrency:
      group: drive-staging-d1-writer
      cancel-in-progress: false
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    defaults:
      run:
        working-directory: apps/drive
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.sha }}
          persist-credentials: false
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: '24.21.0'
      - name: Verify source and lock
        run: |
          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"
          bash scripts/reject-shrinkwrap.sh .
          node scripts/verify-lock-age.mjs
          test "$(npm --version)" = 11.19.0
          test "$(npm config get min-release-age)" = 3
          test "$(npm config get ignore-scripts)" = true
      - name: Install and build exact source
        run: |
          npm ci --ignore-scripts --no-audit --no-fund
          npm run build
      - name: Publish built staging Worker
        run: node scripts/staging-publish.mjs
`;

/** @param {string} workflow */
function assertDisabledPublishJob(workflow) {
  const jobs = workflow.split('\n  publish:\n');
  assert.equal(jobs.length, 2, 'expected exactly one publish job');
  // Ignore job-level prose, but not comments inside scripts or changes to values.
  assert.equal(jobs[1].replace(/^ {4}#[^\n]*\n/gm, '').trimEnd(), disabledPublishJob.trimEnd(),
    'publish job must remain in its approved disabled shape');
}

const stagingWorkflow = () => readFileSync(
  new URL('../../../.github/workflows/drive-staging-preparation.yml', import.meta.url), 'utf8',
);

test('publish job remains disabled and bound to the preparation job and checkout SHA', () => {
  assertDisabledPublishJob(stagingWorkflow());
});

test('disabled publish job rejects environment and secret changes independently', () => {
  const workflow = stagingWorkflow();
  const withJobLine = (line) => workflow.replace('\n  publish:\n', `\n  publish:\n    ${line}\n`);
  assert.doesNotThrow(() => assertDisabledPublishJob(withJobLine('# An open expression starts with ${{')));
  assert.throws(() => assertDisabledPublishJob(withJobLine('environment: staging')), /approved disabled shape/);
  assert.throws(() => assertDisabledPublishJob(withJobLine('env: { TOKEN: "${{ secrets.PLACEHOLDER }}" }')),
    /approved disabled shape/);
});

test('normalizes publish failure without exposing provider diagnostics', (t) => {
  const { root } = fixture(t);
  assert.throws(() => publishStaging(root, () => { throw new Error('sensitive provider output'); }),
    { message: 'staging Worker publication failed' });
});
