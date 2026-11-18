import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishStaging } from './staging-publish.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'drive-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.svelte-kit/cloudflare'), { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(root, '.svelte-kit/cloudflare/_worker.js'), 'synthetic bundle');
  writeFileSync(join(root, 'node_modules/.bin/wrangler'), 'stub');
  const config = { name: 'qerith-drive-staging', main: '.svelte-kit/cloudflare/_worker.js',
    compatibility_date: '2026-07-30',
    assets: { directory: '.svelte-kit/cloudflare', binding: 'ASSETS', run_worker_first: true },
    d1_databases: [{ binding: 'DB', database_name: 'qerith-drive-staging',
      database_id: '87ac8041-ad2d-4650-b0d7-05bb78846f60', migrations_dir: 'migrations' }] };
  const save = () => writeFileSync(join(root, 'wrangler.staging.json'), JSON.stringify(config));
  save();
  return { root, config, save };
}

test('checked-in staging config matches the fixed deployment target', (t) => {
  const { root } = fixture(t);
  const config = readFileSync(new URL('../wrangler.staging.json', import.meta.url), 'utf8');
  writeFileSync(join(root, 'wrangler.staging.json'), config);
  let called = false;
  publishStaging(root, () => { called = true; });
  assert.equal(called, true);
});

test('publishes the validated staging bundle with the pinned runner', (t) => {
  const { root } = fixture(t);
  let called = 0;
  publishStaging(root, (binary, args, options) => {
    called++;
    assert.equal(binary, join(root, 'node_modules/.bin/wrangler'));
    assert.deepEqual(args, ['deploy', '.svelte-kit/cloudflare/_worker.js', '--config', 'wrangler.staging.json']);
    assert.equal(options.cwd, root);
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

test('command-line publisher stays disabled independently of the workflow', () => {
  const result = spawnSync(process.execPath, [new URL('./staging-publish.mjs', import.meta.url).pathname], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /staging publication is disabled until migration admission is implemented and reviewed/);
});

test('publish job remains disabled and has no staging environment or secrets', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-preparation.yml', import.meta.url), 'utf8');
  const job = workflow.split('\n  publish:\n')[1];
  assert.ok(job);
  assert.match(job, /\n    if: \$\{\{ false \}\}/);
  assert.doesNotMatch(job, /\n    environment:/);
  assert.doesNotMatch(job, /secrets\./);
  assert.match(job, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(job, /needs: preparation/);
  assert.match(job, /\n    concurrency:\n      group: drive-staging-d1-writer\n      cancel-in-progress: false/);
});

test('propagates publish failure', (t) => {
  const { root } = fixture(t);
  assert.throws(() => publishStaging(root, () => { throw new Error('publish failed'); }), /publish failed/);
});
