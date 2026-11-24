import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { operatorPublish } from './staging-operator.mjs';

const previousVersion = 'a1111111-1111-1111-1111-111111111111';
const currentVersion = 'b2222222-2222-2222-2222-222222222222';
const emptyList = 'Resource location: remote \n\n✅ No migrations to apply!';
const settings = {
  CLOUDFLARE_API_TOKEN: 'synthetic-publish-token-only',
  QERITH_S3_ENDPOINT: 'https://storage.example.test',
  QERITH_S3_BUCKET: 'fixture',
  QERITH_S3_REGION: 'auto',
  QERITH_S3_STORAGE_EPOCH: 'fixture',
  QERITH_S3_ACCESS_KEY_ID: 'synthetic-access-key',
  QERITH_S3_SECRET_ACCESS_KEY: 'synthetic-secret-key',
};

function fixture(t, { alterTarget, failPending, failPublish, tokenMinutes = 30 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'drive-operator-test-'));
  t.after(() => rmSync(root, { recursive: true }));
  const repo = join(root, 'repo');
  const state = join(root, 'state');
  mkdirSync(repo);
  mkdirSync(state, { mode: 0o700 });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main', '--template=');
  const app = join(repo, 'apps/drive');
  mkdirSync(join(app, 'migrations'), { recursive: true });
  mkdirSync(join(app, 'scripts'));
  writeFileSync(join(app, 'migrations/0001_fixture.sql'), 'SELECT 1;');
  const config = JSON.parse(readFileSync(new URL('../wrangler.staging.json', import.meta.url)));
  alterTarget?.(config);
  writeFileSync(join(app, 'wrangler.staging.json'), JSON.stringify(config));
  const configId = JSON.stringify([settings.QERITH_S3_ENDPOINT, settings.QERITH_S3_BUCKET, settings.QERITH_S3_STORAGE_EPOCH]);
  const identitySha256 = createHash('sha256').update(JSON.stringify([configId, 'auto', settings.QERITH_S3_ACCESS_KEY_ID])).digest('hex');
  writeFileSync(join(app, 'scripts/staging-storage-qualification.json'), JSON.stringify({
    version: 1, sourceSha: 'c'.repeat(40), runId: '1', runAttempt: 1, completionTimeoutMs: 3000,
    passed: true, failures: [], cleanup: 'verified', scope: { identitySha256, policySha256: 'd'.repeat(64) },
  }));
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  const approval = join(state, 'approved-publish');
  const credentials = join(state, 'staging-settings.json');
  const pending = join(state, 'publish-in-progress.jsonl');
  const last = join(state, 'last-publish.jsonl');
  const trace = join(root, 'trace');
  const modeFile = join(root, 'mode');
  writeFileSync(trace, '');
  writeFileSync(credentials, JSON.stringify(settings), { mode: 0o600 });
  const approvalFor = (approved = sha, mode = 'closed') => writeFileSync(approval, `${approved} ${mode}\n`, { mode: 0o600 });
  const readTrace = () => readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean);
  const readRecords = (path = last) => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const run = (program, args, { cwd, env }) => {
    assert.equal(env.DRIVE_BUILD_SHA, sha);
    assert.ok(Object.keys(settings).every(key => !(key in env)));
    if (program === 'git') {
      if (args[0] === 'fetch') {
        assert.deepEqual(args.slice(-2), ['https://github.com/TogetherWeOwn/qerith.git', 'refs/heads/main']);
        args = [...args.slice(0, -2), repo, 'refs/heads/main'];
      }
      return execFileSync(program, args, { cwd, env, encoding: 'utf8' }).trim();
    }
    const cmd = [program, ...args].join(' ');
    if (cmd === 'npm run build') {
      mkdirSync(join(cwd, '.svelte-kit/cloudflare'), { recursive: true });
      mkdirSync(join(cwd, 'node_modules/.bin'), { recursive: true });
      writeFileSync(join(cwd, '.svelte-kit/cloudflare/_worker.js'), 'synthetic artifact');
      writeFileSync(join(cwd, 'node_modules/.bin/wrangler'), `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
const trace = ${JSON.stringify(trace)};
const record = phase => fs.appendFileSync(trace, phase + '\\n');
const seen = phase => fs.readFileSync(trace, 'utf8').split('\\n').includes(phase);
assert.ok(Object.keys(process.env).every(key => !key.startsWith('QERITH_S3_')));
if (args.includes('--dry-run')) {
  assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
  return record('dry-run');
}
assert.equal(process.env.CLOUDFLARE_API_TOKEN, 'synthetic-publish-token-only');
assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, '209cf7dd678adfb683947dd7874d05af');
if (args[0] === 'deployments') {
  console.log(JSON.stringify({ versions: [{ percentage: 100, version_id: seen('deploy') ? '${currentVersion}' : '${previousVersion}' }] }));
  return record('version');
}
if (args[0] === 'deploy') {
  record('deploy');
  assert.ok(seen('pending'));
  const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1]));
  const secrets = JSON.parse(fs.readFileSync(args[args.indexOf('--secrets-file') + 1]));
  assert.equal(config.vars.DRIVE_STAGING_INVITE_ACCEPTANCE, '0');
  assert.equal(config.vars.DRIVE_OWNER_ENROLLMENT_RELEASE, 'disabled');
  assert.equal(secrets.DRIVE_S3_SECRET_ACCESS_KEY, 'synthetic-secret-key');
  fs.writeFileSync(${JSON.stringify(modeFile)}, config.vars.DRIVE_ORIGIN);
  process.exitCode = ${failPublish ? 1 : 0};
  return;
}
assert.equal(args[0], 'd1');
const journal = () => fs.readFileSync(${JSON.stringify(pending)}, 'utf8');
if (args.includes('time-travel')) {
  assert.ok(journal().includes('${previousVersion}'));
  record('bookmark');
  return console.log(JSON.stringify({ bookmark: 'synthetic-bookmark' }));
}
assert.ok(journal().includes('synthetic-bookmark'));
if (args.includes('list')) {
  const pending = seen('apply');
  record(pending ? 'pending' : 'list');
  return console.log(pending && ${!!failPending} ? 'Unexpected pending migrations' : ${JSON.stringify(emptyList)});
}
if (args.includes('execute')) {
  const applied = seen('apply');
  record(applied ? 'ledger-after' : 'ledger-before');
  const results = applied ? [{ id: 1, name: '0001_fixture.sql', applied_at: '2026-11-24 00:00:00' }] : [];
  return console.log(JSON.stringify([{ success: true, results }]));
}
assert.ok(args.includes('apply'));
record('apply');
`, { mode: 0o700 });
    }
    const outputs = new Map([
      ['bash scripts/reject-shrinkwrap.sh .', ''], ['node --version', 'v24.21.0'], ['npm --version', '11.19.0'],
      ['npm config get min-release-age', '3'], ['npm config get ignore-scripts', 'true'],
      ['node scripts/verify-lock-age.mjs', ''], ['npm ci --ignore-scripts --no-audit --no-fund', ''], ['npm run build', ''],
    ]);
    assert.ok(outputs.has(cmd), cmd);
    return outputs.get(cmd);
  };
  const send = async (url, { headers, redirect }) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/user/tokens/verify');
    assert.equal(headers.authorization, `Bearer ${settings.CLOUDFLARE_API_TOKEN}`);
    assert.equal(redirect, 'error');
    return Response.json({ success: true, result: { status: 'active',
      expires_on: new Date(Date.now() + tokenMinutes * 60_000).toISOString() } });
  };
  const publish = (requested = sha, mode, verify = send) => operatorPublish(requested, state, mode, { run, send: verify });
  return { sha, state, approval, credentials, pending, modeFile, approvalFor, publish, send, readTrace, readRecords };
}

test('operator builds and publishes a reviewed SHA closed and records D1 and Worker evidence', async (t) => {
  const f = fixture(t);
  f.approvalFor();
  await f.publish();
  assert.deepEqual(f.readTrace(), ['dry-run', 'version', 'bookmark', 'list', 'ledger-before', 'apply', 'ledger-after', 'pending', 'deploy', 'version']);
  assert.equal(readFileSync(f.modeFile, 'utf8'), 'disabled');
  const [admitted, recover, migrated, published] = f.readRecords();
  assert.equal(admitted.previousVersion, previousVersion);
  assert.equal(recover.bookmark, 'synthetic-bookmark');
  assert.deepEqual(migrated.before, []);
  assert.equal(migrated.after[0].name, '0001_fixture.sql');
  assert.equal(published.currentVersion, currentVersion);
  assert.ok([admitted, recover, migrated, published].every(record => record.sha === f.sha && record.mode === 'closed'));
  assert.ok(!existsSync(f.pending));
});

test('operator rejects unapproved source, wrong main tip, and mismatched target before provider access', async (t) => {
  const f = fixture(t, { alterTarget: config => { config.d1_databases[0].database_id = currentVersion; } });
  const never = () => assert.fail('provider token verification was attempted');
  const requested = 'f'.repeat(40);
  f.approvalFor();
  await assert.rejects(f.publish(requested, undefined, never), /approval/);
  await assert.rejects(f.publish(f.sha, 'owner-preview', never), /approval/);
  f.approvalFor(requested);
  await assert.rejects(operatorPublish(requested, f.state, 'closed', { send: never, run: (program, args) => {
    assert.equal(program, 'git');
    return args[0] === 'rev-parse' ? f.sha : '';
  } }), /fetched main tip/);
  f.approvalFor();
  await assert.rejects(f.publish(f.sha, undefined, never), /invalid staging Worker configuration/);
  assert.deepEqual(f.readTrace(), []);
  assert.ok(!existsSync(f.pending));
});

test('operator refuses unmatched storage, reusable tokens, and an inherited approval', async (t) => {
  const f = fixture(t, { tokenMinutes: 120 });
  f.approvalFor();
  writeFileSync(f.credentials, JSON.stringify({ ...settings, QERITH_S3_BUCKET: 'wrong-fixture' }));
  await assert.rejects(f.publish(f.sha, undefined, () => assert.fail('provider access attempted')), /passing qualification/);
  writeFileSync(f.credentials, JSON.stringify(settings));
  await assert.rejects(f.publish(), /active staging token/);
  unlinkSync(f.approval);
  const cli = spawnSync(process.execPath, [new URL('./staging-operator.mjs', import.meta.url).pathname, f.sha, f.state], {
    encoding: 'utf8', env: { ...process.env, EXPECTED_MAIN_SHA: f.sha, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(cli.status, 1, cli.stderr);
  assert.doesNotMatch(cli.stderr, /synthetic-|ENOENT/);
  assert.deepEqual(f.readTrace(), ['dry-run', 'dry-run']);
});

test('operator preserves the recovery record and blocks retry after a pending list or publish failure', async (t) => {
  for (const options of [{ failPending: true }, { failPublish: true }]) {
    const f = fixture(t, options);
    f.approvalFor();
    await assert.rejects(f.publish(), /needs reconciliation/);
    assert.equal(f.readRecords(f.pending)[1].bookmark, 'synthetic-bookmark');
    if (options.failPending) assert.ok(!f.readTrace().includes('deploy'));
    await assert.rejects(f.publish(), /in-progress or unreconciled/);
  }
});

test('switch and undo drain the admitted path before handing off approval', async (t) => {
  const f = fixture(t);
  // The old publisher is still draining, so the Operator has no approval.
  await assert.rejects(f.publish(), /ENOENT/);
  assert.deepEqual(f.readTrace(), []);
  // After the old path has drained and been disabled, arm the reviewed mode.
  f.approvalFor(f.sha, 'owner-preview');
  const finish = Promise.withResolvers();
  const started = Promise.withResolvers();
  const attempt = f.publish(f.sha, 'owner-preview', async (...args) => {
    started.resolve();
    await finish.promise;
    return f.send(...args);
  });
  await started.promise;
  assert.ok(existsSync(f.pending));
  await assert.rejects(f.publish(f.sha, 'owner-preview'), /in-progress or unreconciled/);
  // Undo withdraws approval, then waits for the in-flight marker to drain.
  unlinkSync(f.approval);
  finish.resolve();
  await assert.rejects(attempt, /ENOENT/);
  assert.ok(!existsSync(f.pending));
  assert.deepEqual(f.readTrace(), ['dry-run', 'version']);
  await assert.rejects(f.publish(f.sha, 'owner-preview'), /ENOENT/);
});
