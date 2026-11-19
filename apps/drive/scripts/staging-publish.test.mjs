import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('publishes the validated staging bundle with the pinned runner', async (t) => {
  const { root } = fixture(t);
  let called = 0;
  await publishStaging(root, (binary, args, options) => {
    called++;
    assert.equal(binary, join(root, 'node_modules/.bin/wrangler'));
    assert.deepEqual(args, ['deploy', '.svelte-kit/cloudflare/_worker.js', '--config', 'wrangler.staging.json']);
    assert.equal(options.cwd, root);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.detached, true);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  });
  assert.equal(called, 1);
});

test('passes the ephemeral authorization as a Worker secret file, not via argv or child env', async (t) => {
  const { root } = fixture(t);
  const value = `${Date.now() + 60_000}:${'a'.repeat(43)}`;
  let file;
  await publish(root, (_binary, args, options) => {
    assert.equal(args.at(-2), '--secrets-file');
    file = args.at(-1);
    assert.ok(!args.includes(value) && !Object.hasOwn(options.env, 'DRIVE_OWNER_ENROLLMENT'));
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).DRIVE_OWNER_ENROLLMENT === value);
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    process.nextTick(() => child.emit('close', 0));
    return child;
  }, accountId, value);
  assert.equal(existsSync(file), false);
  await assert.rejects(publish(root, () => assert.fail('runner invoked'), accountId, `1000000000000:${'a'.repeat(43)}`),
    /invalid or expired staging enrollment authorization/);
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
    [config, 'compatibility_flags', ['nodejs_compat']],
    [config, 'compatibility_flags', ['enable_request_signal']],
    [config, 'compatibility_flags', ['nodejs_compat', 'enable_request_signal', 'other']],
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

test('command-line publisher refuses requests outside the protected dispatch job', (t) => {
  const { root } = fixture(t);
  const script = new URL('./staging-publish.mjs', import.meta.url).pathname;
  const env = { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'synthetic',
    GITHUB_ACTIONS: 'true', GITHUB_JOB: 'publish', GITHUB_REPOSITORY: 'TogetherWeOwn/qerith',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40) };
  const run = (args, overrides) => spawnSync(process.execPath, [script, ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 5000,
  });
  assert.match(run([], {}).stderr, /unrecognized staging publisher arguments/);
  for (const overrides of [
    { GITHUB_ACTIONS: '' }, { GITHUB_JOB: 'preparation' }, { GITHUB_REPOSITORY: 'other/qerith' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/other' },
    { GITHUB_SHA: 'invalid' }, { CLOUDFLARE_API_TOKEN: '' },
  ]) {
    const result = run(['--publish'], overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /publication requires the protected staging dispatch job/);
  }
});

test('publisher terminates launcher descendants on overflow and timeout', async (t) => {
  const { root } = fixture(t);
  const launcher = join(root, 'node_modules/.bin/wrangler');
  writeFileSync(launcher, '#!/bin/sh\ntouch "$MARKER.started"\n(sleep 2; printf escaped > "$MARKER") &\nif [ "$MODE" = overflow ]; then /usr/bin/yes x | /usr/bin/head -c 100000; fi\nwait\n');
  chmodSync(launcher, 0o700);
  const source = readFileSync(new URL('./staging-publish.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('setTimeout(stop, 110000)'));
  const script = join(root, 'publisher.mjs');
  for (const mode of ['overflow', 'timeout']) {
    // Only the timeout case may kill the child before its marker via the deadline.
    writeFileSync(script, mode === 'timeout' ? source.replace('setTimeout(stop, 110000)', 'setTimeout(stop, 1000)') : source);
    const marker = join(root, mode);
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'const { publishStaging } = await import(process.argv[2]); await publishStaging(process.cwd());', 'test-driver', script], {
      cwd: root, env: { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: accountId, MARKER: marker, MODE: mode },
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.ok(existsSync(`${marker}.started`), `${mode} launcher never started`);
    assert.match(result.stderr, /staging Worker publication failed/);
    assert.doesNotMatch(result.stderr, /x{20}/);
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(existsSync(marker), false, `${mode} descendant survived`);
  }
});

test('normalizes publish failure without exposing provider diagnostics', async (t) => {
  const { root } = fixture(t);
  await assert.rejects(publishStaging(root, () => { throw new Error('sensitive provider output'); }),
    { message: 'staging Worker publication failed' });
});
