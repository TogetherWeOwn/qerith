import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertDispatch, qualificationReceiptName } from './staging-qualification.mjs';
import { runQualificationLifecycle } from './staging-qualification-lifecycle.mjs';
import { cleanQualificationR2 } from './staging-qualification-cleanup.mjs';
import { exerciseQualificationStorage } from './staging-qualification-storage-cases.mjs';
import { qualificationRecoveryWriter, readQualificationRecoveryRecord } from './staging-qualification-recovery-record.mjs';
import { qualificationR2RecoveryStore } from './staging-qualification-recovery-r2.mjs';
import { verifyRecoveryR2Expiry } from './staging-qualification-expiry.mjs';

const recoverySource = Object.freeze({ sha: 'a'.repeat(40), runId: '182', attempt: '3' });
const recoveryContext = { ...recoverySource, prefix: 'drive-qualification/full-v0/182/3/' };
const d1Record = { ...recoveryContext, kind: 'd1', bookmark: 'offline_bookmark' };
const workerRecord = { ...recoveryContext, kind: 'worker', version: '11111111-1111-1111-1111-111111111111',
  expiresAt: '1780000000000', previousVersion: '22222222-2222-2222-2222-222222222222',
  previousDeployment: '33333333-3333-3333-3333-333333333333' };
const invalidRecord = { message: 'Staging qualification recovery record is unverified.' };

test('recovery writer requires fresh readback of a create-only record before acknowledging', async () => {
  const controller = new AbortController();
  const { signal } = controller;
  const enteredRead = Promise.withResolvers();
  const readback = Promise.withResolvers();
  const stored = new Map();
  const store = {
    async create(key, body, receivedSignal) {
      assert.equal(receivedSignal, signal);
      if (stored.has(key)) return false;
      stored.set(key, body);
      return true;
    },
    async read(key, options) {
      assert.deepEqual(options, { maxBytes: 2048, signal });
      enteredRead.resolve();
      await readback.promise;
      return Uint8Array.from(stored.get(key));
    },
  };
  const write = qualificationRecoveryWriter(recoverySource, store);
  let acknowledged = false;
  const pending = write({ ...d1Record, internal: 'not serialized' }, signal).then(value => {
    acknowledged = value;
    return value;
  });
  await Promise.race([enteredRead.promise, pending]);
  assert.equal(acknowledged, false);
  readback.resolve();
  assert.equal(await pending, true);
  assert.equal(await write(workerRecord, signal), true);
  const { sha, runId, attempt } = recoverySource;
  for (const record of [d1Record, workerRecord]) {
    const { prefix, ...payload } = record;
    const key = `drive-staging-recovery-${record.kind}-${sha}-run-${runId}-attempt-${attempt}`;
    assert.deepEqual(stored.get(key), new TextEncoder().encode(JSON.stringify({
      schema: 'drive-staging-recovery.v1', kind: record.kind, sha, runId, attempt,
      ...(record.kind === 'd1' ? { bookmark: record.bookmark } : {
        version: record.version, expiresAt: record.expiresAt, previousVersion: record.previousVersion,
        previousDeployment: record.previousDeployment,
      }),
    })));
    assert.deepEqual(await readQualificationRecoveryRecord(recoverySource, record.kind, store, signal),
      { schema: 'drive-staging-recovery.v1', ...payload });
  }
  await assert.rejects(write(d1Record, signal), invalidRecord);
  assert.equal(stored.size, 2);
});

test('recovery writer never creates after cancellation during serialization', async () => {
  const controller = new AbortController();
  let creates = 0;
  const write = qualificationRecoveryWriter(recoverySource, {
    create() { creates++; return true; },
    read() { return Buffer.from(canonicalD1); },
  });
  await assert.rejects(write({ ...d1Record, get bookmark() {
    controller.abort();
    return d1Record.bookmark;
  } }, controller.signal), invalidRecord);
  assert.equal(creates, 0);
});

test('recovery store methods retain their receiver and setup errors are sanitized', async () => {
  const store = {
    records: new Map(),
    create(key, value) { this.records.set(key, Uint8Array.from(value)); return true; },
    read(key) { return this.records.get(key); },
  };
  assert.equal(await qualificationRecoveryWriter(recoverySource, store)(d1Record), true);
  assert.equal((await readQualificationRecoveryRecord(recoverySource, 'd1', store)).bookmark, d1Record.bookmark);
  for (const malformed of [undefined, null, { read: true }, { get read() { throw new Error('store setup failed'); } }]) {
    assert.throws(() => qualificationRecoveryWriter(recoverySource, malformed), invalidRecord);
    await assert.rejects(readQualificationRecoveryRecord(recoverySource, 'd1', malformed), invalidRecord);
  }
  assert.throws(() => qualificationRecoveryWriter(recoverySource, {
    ...store, get create() { throw new Error('store setup failed'); },
  }), invalidRecord);
});

test('recovery writer refuses invalid scope, ambiguous creation, readback drift and cancellation', async () => {
  const calls = [];
  assert.throws(() => qualificationRecoveryWriter(recoverySource, { create: () => true }), invalidRecord);
  const controller = new AbortController();
  let outcome;
  const write = qualificationRecoveryWriter(recoverySource, {
    create() {
      calls.push('create');
      if (outcome === 'lost-ack') throw new Error('Create result unknown');
      return true;
    },
    read() {
      calls.push('read');
      if (outcome === 'cancelled') controller.abort();
      return Buffer.from(canonicalD1 + (outcome === 'drift' ? '\n' : ''));
    },
  });
  for (const record of [{ ...d1Record, attempt: '2' }, { ...d1Record, prefix: 'another-prefix/' },
    { ...d1Record, bookmark: 'line\nbreak' }, { ...workerRecord, version: workerRecord.previousVersion }]) {
    await assert.rejects(write(record), invalidRecord);
    assert.deepEqual(calls, []);
  }
  for (const [result, expected] of [['lost-ack', ['create']], ['drift', ['create', 'read']],
    ['cancelled', ['create', 'read']]]) {
    outcome = result;
    await assert.rejects(write(d1Record, controller.signal), invalidRecord);
    assert.deepEqual(calls.splice(0), expected);
  }
  await assert.rejects(write(d1Record, controller.signal), invalidRecord);
  assert.deepEqual(calls, []);
});

const canonicalD1 = JSON.stringify({ schema: 'drive-staging-recovery.v1', kind: 'd1',
  ...recoverySource, bookmark: d1Record.bookmark });

test('recovery writer validates and stores the same bookmark', async () => {
  let reads = 0;
  let body;
  const store = {
    create(_key, value) { body = value; return true; },
    read() { return body; },
  };
  const write = qualificationRecoveryWriter(recoverySource, store);
  assert.equal(await write({ ...d1Record, get bookmark() {
    return ++reads === 1 ? d1Record.bookmark : 'not a bookmark';
  } }), true);
  assert.equal(reads, 1);
  assert.equal((await readQualificationRecoveryRecord(recoverySource, 'd1', store)).bookmark, d1Record.bookmark);
});

test('recovery writer and reader compare the actual byte view without conversion', async () => {
  const canonical = Buffer.from(canonicalD1);
  const backing = new Uint8Array(canonical.length + 2).fill(0xff);
  backing.set(canonical, 1);
  const view = backing.subarray(1, -1);
  const unused = () => assert.fail('Byte validation must not call object hooks');
  Object.defineProperties(view, { byteLength: { get: unused }, valueOf: { value: unused } });
  const store = { create: () => true, read: () => view };
  const write = qualificationRecoveryWriter(recoverySource, store);
  assert.equal(await write(d1Record), true);
  assert.equal((await readQualificationRecoveryRecord(recoverySource, 'd1', store)).bookmark, d1Record.bookmark);
  view[0] = 0xff;
  await assert.rejects(write(d1Record), invalidRecord);
  await assert.rejects(readQualificationRecoveryRecord(recoverySource, 'd1', store), invalidRecord);
});

test('recovery writer and reader reject a BOM prefix and normalized text', async () => {
  const prefixed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonicalD1)]);
  for (const read of [() => prefixed, () => new Response(prefixed).text()]) {
    const store = { create: () => true, read };
    await assert.rejects(qualificationRecoveryWriter(recoverySource, store)(d1Record), invalidRecord);
    await assert.rejects(readQualificationRecoveryRecord(recoverySource, 'd1', store), invalidRecord);
  }
});

test('recovery reader rejects copied, malformed, oversized and cancelled records', async () => {
  const invalidBodies = ['{', 'x'.repeat(2049), canonicalD1.replace('"3"', '"2"'),
    canonicalD1.replace('"182"', '"183"'), canonicalD1.replace(recoverySource.sha, 'b'.repeat(40)),
    canonicalD1.replace('recovery.v1', 'recovery.v2'), canonicalD1.replace('"d1"', '"worker"'),
    `{"unexpected":true,${canonicalD1.slice(1)}`, `{"kind":"d1",${canonicalD1.slice(1)}`];
  for (const body of [undefined, ...invalidBodies.map(text => Buffer.from(text))]) {
    await assert.rejects(readQualificationRecoveryRecord(recoverySource, 'd1', { read: () => body }), invalidRecord);
  }
  const controller = new AbortController();
  const store = { read() { controller.abort(); return Buffer.from(canonicalD1); } };
  await assert.rejects(readQualificationRecoveryRecord(recoverySource, 'd1', store, controller.signal), invalidRecord);
  let reads = 0;
  await assert.rejects(readQualificationRecoveryRecord({ ...recoverySource, runId: '../182' }, 'd1', {
    read() { reads++; return Buffer.from(canonicalD1); },
  }), invalidRecord);
  assert.equal(reads, 0);
});

const recoveryClock = Date.UTC(2026, 10, 20);
const recoveryObject = (body, modified = recoveryClock, date = recoveryClock) => ({ status: 200, body,
  headers: new Headers({ date: new Date(date).toUTCString(), 'last-modified': new Date(modified).toUTCString(),
    'content-length': body.byteLength }) });

test('R2 recovery tolerates a fresh provider clock lead without extending the three-day cutoff', async () => {
  const bytes = Buffer.from(canonicalD1);
  const key = `drive-staging-recovery-d1-${recoverySource.sha}-run-182-attempt-3`;
  const read = response => qualificationR2RecoveryStore(recoverySource, { now: () => recoveryClock,
    request: () => response }).read(key, { maxBytes: 2048 });
  const ahead = recoveryClock + 1000, behind = recoveryClock - 1000;
  const ttl = 3 * 86_400_000;
  assert.deepEqual(await read(recoveryObject(bytes, ahead, ahead)), bytes);
  assert.deepEqual(await read(recoveryObject(bytes, ahead - ttl + 1000, ahead)), bytes);
  const missingDate = recoveryObject(bytes), invalidDate = recoveryObject(bytes);
  missingDate.headers.delete('date');
  invalidDate.headers.set('date', '2026-11-20');
  for (const response of [recoveryObject(bytes, ahead - ttl, ahead), recoveryObject(bytes, recoveryClock - ttl, behind),
    recoveryObject(bytes, ahead, recoveryClock), recoveryObject(bytes, behind, recoveryClock - 31_000),
    recoveryObject(bytes, recoveryClock - 31_000, recoveryClock - 31_000), missingDate, invalidDate]) {
    await assert.rejects(read(response), /recovery storage is unverified/);
  }
});

test('R2 recovery creates both exact keys and a fresh store reads them without local state', async () => {
  const durable = new Map();
  const calls = [];
  const signal = new AbortController().signal;
  const makeStore = () => qualificationR2RecoveryStore(recoverySource, { now: () => recoveryClock,
    verifyRetention: async () => true, request: async ({ method, key, body, headers, maxResponseBytes, signal: sent }) => {
      assert.equal(sent, signal);
      calls.push([method, key]);
      if (method === 'PUT') {
        assert.equal(headers['if-none-match'], '*');
        assert.equal(maxResponseBytes, 0);
        if (durable.has(key)) return { status: 412 };
        durable.set(key, Uint8Array.from(body));
        return { status: 200, headers: new Headers({ etag: '"created"' }) };
      }
      assert.equal(headers['cache-control'], 'no-cache, no-store');
      assert.equal(maxResponseBytes, 2048);
      return recoveryObject(durable.get(key));
    } });
  const write = qualificationRecoveryWriter(recoverySource, makeStore());
  for (const { prefix, ...record } of [d1Record, workerRecord]) {
    assert.equal(await write({ prefix, ...record }, signal), true);
    assert.deepEqual(await readQualificationRecoveryRecord(recoverySource, record.kind, makeStore(), signal),
      { schema: 'drive-staging-recovery.v1', ...record });
    const key = `drive-qualification/recovery/drive-staging-recovery-${record.kind}-${record.sha}-run-182-attempt-3`;
    assert.deepEqual(calls.splice(0), [['PUT', key], ['GET', key], ['GET', key]]);
  }
  await assert.rejects(write({ ...d1Record, bookmark: 'replacement' }, signal), invalidRecord);
  assert.deepEqual(calls.splice(0).map(([method]) => method), ['PUT']);
  for (const source of [{ ...recoverySource, attempt: '4' }, { ...recoverySource, runId: '183' },
    { ...recoverySource, sha: 'b'.repeat(40) }]) {
    await assert.rejects(readQualificationRecoveryRecord(source, 'd1', makeStore(), signal), invalidRecord);
  }
  assert.deepEqual(calls, []);
});

test('R2 recovery returns raw bytes without attempting UTF-8 decoding', async () => {
  const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, 0xff);
  const store = qualificationR2RecoveryStore(recoverySource, { now: () => recoveryClock,
    request: () => recoveryObject(bytes) });
  const key = `drive-staging-recovery-d1-${recoverySource.sha}-run-182-attempt-3`;
  assert.deepEqual(await store.read(key, { maxBytes: 2048 }), bytes);
});

test('R2 recovery fails closed on a lost PUT acknowledgement and invalid byte readback', async () => {
  const methods = [];
  let sent;
  const run = result => {
    const store = qualificationR2RecoveryStore(recoverySource, { now: () => recoveryClock,
      verifyRetention: () => true, request({ method, body }) {
        methods.push(method);
        if (method === 'GET') return result;
        sent = body;
        if (!result) throw new Error('response lost after commit');
        return { status: 200, headers: new Headers({ etag: '"created"' }) };
      } });
    return qualificationRecoveryWriter(recoverySource, store)(d1Record);
  };
  await assert.rejects(run(), invalidRecord);
  assert.deepEqual(sent, Uint8Array.from(Buffer.from(canonicalD1)));
  assert.deepEqual(methods.splice(0), ['PUT']);
  for (const response of [recoveryObject(Buffer.from(String.fromCodePoint(0xfeff) + canonicalD1)), recoveryObject(Buffer.alloc(2049)),
    recoveryObject(Buffer.from([0xff])), recoveryObject(Buffer.from(canonicalD1 + '\n')),
    recoveryObject(Buffer.from(canonicalD1), recoveryClock - 3 * 86_400_000), { status: 404, headers: new Headers() }]) {
    await assert.rejects(run(response), invalidRecord);
    assert.deepEqual(methods.splice(0), ['PUT', 'GET']);
  }
});

test('R2 recovery retention requires a covering three-day rule and refuses a write without it', async () => {
  const rule = (prefix, days) => ({ enabled: true, conditions: { prefix },
    deleteObjectsTransition: { condition: { type: 'Age', maxAge: days * 86_400 } } });
  const covering = rule('drive-qualification/', 3);
  const binding = { account: 'offline', settings: { bucket: 'fixture' } };
  const verify = rules => verifyRecoveryR2Expiry(binding, 'fixture', undefined, async (url, init) => {
    assert.match(url, /\/accounts\/offline\/r2\/buckets\/fixture\/lifecycle$/);
    assert.equal(init.method, 'GET');
    return Response.json({ success: true, errors: [], result: { rules } });
  });
  assert.equal(await verify([covering, rule(recoveryContext.prefix, 1)]), true);
  for (const rules of [[rule(recoveryContext.prefix, 3)], [rule('', 3)],
    [covering, rule('drive-qualification/recovery/partial', 2)], [covering, rule('drive-qualification/recovery/', 4)]]) {
    await assert.rejects(verify(rules));
  }
  let sends = 0;
  const store = qualificationR2RecoveryStore(recoverySource, { verifyRetention: () => verify([]), request: () => sends++ });
  await assert.rejects(qualificationRecoveryWriter(recoverySource, store)(d1Record), invalidRecord);
  assert.equal(sends, 0);
});

function history(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'drive-qualification-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Drive', '-c', 'user.email=drive@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main', '--template=');
  git('commit', '-q', '--allow-empty', '-m', 'ancestor');
  const ancestor = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'dispatch');
  const head = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'main advanced');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-q', '--detach', head);
  const env = {
    GITHUB_REPOSITORY: 'TogetherWeOwn/qerith',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: head,
    TESTED_SHA: head,
    GITHUB_RUN_ID: '182',
    GITHUB_RUN_ATTEMPT: '3',
  };
  return { cwd, git, ancestor, env };
}

test('dispatch, checkout and fetched main history must independently agree', t => {
  const { cwd, git, ancestor, env } = history(t);
  assert.equal(assertDispatch(env, cwd), env.GITHUB_SHA);
  for (const override of [
    { GITHUB_REPOSITORY: 'fork/qerith' },
    { GITHUB_EVENT_NAME: 'workflow_call' },
    { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_REF: 'refs/tags/main' },
    { TESTED_SHA: ancestor },
  ]) {
    assert.throws(() => assertDispatch({ ...env, ...override }, cwd), /manual dispatch on main|40-hex dispatch SHA/);
  }
  for (const bad of [undefined, '', 'A'.repeat(40), 'a'.repeat(39), `${env.TESTED_SHA}\n`, 'HEAD']) {
    assert.throws(() => assertDispatch({ ...env, TESTED_SHA: bad, GITHUB_SHA: bad }, cwd), /40-hex/);
  }
  git('switch', '-q', '--detach', ancestor);
  assert.throws(() => assertDispatch(env, cwd), /checkout/);
  git('commit', '-q', '--allow-empty', '-m', 'off-main');
  const offMain = git('rev-parse', 'HEAD');
  assert.throws(() => assertDispatch({ ...env, TESTED_SHA: offMain, GITHUB_SHA: offMain }, cwd), /origin\/main/);
  git('switch', '-q', '--detach', env.GITHUB_SHA);
  git('update-ref', '-d', 'refs/remotes/origin/main');
  assert.throws(() => assertDispatch(env, cwd), /origin\/main/);
});

test('only a complete successful full-v0 run has the pinned consumer name', t => {
  const { cwd, env, ancestor } = history(t);
  // Keep this fixture independent so removing a case from the policy cannot weaken the test.
  const results = {
    'sha-bound-readiness': 'pass',
    'passkey-positive': 'pass',
    'passkey-negative': 'pass',
    'invite-acceptance': 'pass',
    'member-revocation': 'pass',
    'cross-user-denial': 'pass',
    'authenticated-file-access': 'pass',
    'unauthenticated-file-denial': 'pass',
    's3-multipart': 'pass',
    's3-range': 'pass',
    's3-retry': 'pass',
    's3-persistence': 'pass',
    'large-transfer-hash': 'pass',
    'interrupted-transfer-resume': 'pass',
    'folder-operations': 'pass',
    'share-and-revoke': 'pass',
    'delete-envelope': 'pass',
    'delete-boundary-and-safe-fallback': 'pass',
    'delete-rollback-and-retry': 'pass',
    'delete-provider-proof': 'pass',
    'migration-ledger': 'pass',
    'time-travel-bookmark': 'pass',
    'rollback-or-disablement': 'pass',
    'zero-idle-inventory': 'pass',
    'prefix-cleanup-verified': 'pass',
  };
  const evidence = { mode: 'full-v0', sha: env.GITHUB_SHA, runId: '182', attempt: '3', results };
  const name = (proof = evidence, status = 'success', context = env) => qualificationReceiptName(context, proof, status, cwd);
  assert.equal(name(), `drive-staging-qualification-${env.GITHUB_SHA}-attempt-3`);
  for (const override of [{ mode: 'preview' }, { mode: 'fixture' }, { sha: ancestor }, { runId: '181' }, { attempt: '2' }]) {
    assert.throws(() => name({ ...evidence, ...override }), /full-v0 evidence/);
  }
  for (const status of ['failure', 'cancelled', 'skipped', 'neutral', null]) {
    assert.throws(() => name(evidence, status), /successful full-v0/);
  }
  for (const attempt of ['0', '03', '3\n', 3]) {
    assert.throws(() => name({ ...evidence, attempt }, 'success', { ...env, GITHUB_RUN_ATTEMPT: attempt }), /attempt/);
  }
  for (const caseName of Object.keys(results)) {
    const { [caseName]: _, ...incomplete } = results;
    assert.throws(() => name({ ...evidence, results: incomplete }), /must pass/, `missing ${caseName}`);
  }
  for (const outcome of ['fail', 'skip', 'cancelled', 'unverified', true]) {
    assert.throws(() => name({ ...evidence, results: { ...results, 'prefix-cleanup-verified': outcome } }), /must pass/);
  }
  assert.throws(() => name({ ...evidence, results: { ...results, 'passkey-positive': 'skip' } }), /must pass/);
  assert.throws(() => name({ ...evidence, results: { ...results, 'fixture-only': 'pass' } }), /must pass/);
});

function lifecycle(t, failure, driftKind) {
  const controller = new AbortController();
  const { cwd, env } = history(t);
  Object.assign(env, { GITHUB_ACTIONS: 'true', GITHUB_JOB: 'qualification',
    GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/drive-staging-qualification.yml@refs/heads/main' });
  const events = [];
  const prefix = 'drive-qualification/full-v0/182/3/';
  const failures = [].concat(failure);
  const step = name => {
    events.push(name);
    return !failures.includes(name);
  };
  const { version, expiresAt, previousVersion, previousDeployment } = workerRecord;
  const candidate = { version, expiresAt, previousVersion, previousDeployment };
  const stored = new Map();
  const writeRecovery = qualificationRecoveryWriter({ ...recoverySource, sha: env.TESTED_SHA }, {
    create(key, body) {
      step(`create-${JSON.parse(Buffer.from(body).toString('utf8')).kind}`);
      if (stored.has(key)) return false;
      stored.set(key, Buffer.from(body));
      return true;
    },
    read(key) {
      const body = stored.get(key);
      const { kind } = JSON.parse(body.toString('utf8'));
      step(`read-${kind}`);
      return kind === driftKind ? Buffer.concat([body, Buffer.from('\n')]) : Buffer.from(body);
    },
  });
  const ops = {
    assertFullV0: () => step('full-v0'),
    inventory({ phase, sha }, signal) {
      assert.equal(sha, env.TESTED_SHA);
      assert.equal(signal.aborted, false);
      if (failure === 'cancel-after-restore' && phase === 'after') controller.abort();
      return step(`inventory-${phase}`);
    },
    recordRecovery(record, signal) {
      return step(`record-${record.kind}`) && writeRecovery(record, signal);
    },
    async exercise({ version: activeVersion, prefix: keyPrefix }, signal) {
      assert.equal(activeVersion, version);
      assert.equal(keyPrefix, prefix);
      step('exercise');
      if (failure === 'cancel') controller.abort();
      await Promise.resolve();
      step('exercise-settled');
      signal.throwIfAborted();
      if (failure === 'exercise') throw new Error('Case failed');
      return { 'passkey-positive': 'pass' };
    },
    cleanup({ prefix: keyPrefix, version: activeVersion }, signal) {
      assert.equal(keyPrefix, prefix);
      assert.equal(activeVersion, version);
      assert.equal(signal.aborted, false);
      return step('cleanup');
    },
  };
  const adapters = {
    upload() {
      if (!step('upload')) throw new Error('Reconcile staging before retrying');
      return candidate;
    },
    async migrate({ recordRecovery }) {
      await recordRecovery({ bookmark: 'bookmark' });
      step('migrate');
      return { bookmark: 'bookmark' };
    },
    probe: () => step('probe'),
    async worker({ upload, recordRecovery, probe, exercise, cleanup }, _env, _cwd, signal) {
      assert.equal(upload, candidate);
      await recordRecovery(candidate);
      step('activate');
      try {
        if (!probe()) throw new Error('Readiness failed');
        try {
          return { cases: await exercise(candidate, signal), restoredDeployment: 'restored' };
        } finally {
          if (await cleanup(candidate, new AbortController().signal) !== true) {
            throw new Error('Qualification prefix cleanup is unverified.');
          }
        }
      } finally {
        if (!step('restore')) throw new Error('Worker rollback is unverified; reconcile before retrying.');
      }
    },
  };
  return { events, stored, testedSha: env.TESTED_SHA,
    run: () => runQualificationLifecycle(ops, env, cwd, controller.signal, adapters) };
}

const successOrder = ['full-v0', 'inventory-before', 'upload', 'record-d1', 'create-d1', 'read-d1', 'migrate',
  'record-worker', 'create-worker', 'read-worker', 'activate', 'probe', 'exercise', 'exercise-settled',
  'cleanup', 'restore', 'inventory-after'];

test('qualification lifecycle keeps cleanup inside the candidate and inventories after restore', async t => {
  const { run, events, stored, testedSha } = lifecycle(t);
  assert.deepEqual(await run(), { migrations: { bookmark: 'bookmark' },
    deployment: { cases: { 'passkey-positive': 'pass' }, restoredDeployment: 'restored' } });
  assert.deepEqual(events, successOrder);
  const payloads = Array.from(stored.values(), body => JSON.parse(body.toString('utf8')));
  const scope = { schema: 'drive-staging-recovery.v1', ...recoverySource, sha: testedSha };
  const { version, expiresAt, previousVersion, previousDeployment } = workerRecord;
  assert.deepEqual(payloads, [
    { ...scope, kind: 'd1', bookmark: 'bookmark' },
    { ...scope, kind: 'worker', version, expiresAt, previousVersion, previousDeployment },
  ]);
});

test('qualification lifecycle rejects missing admission, a stale baseline and unrecorded recovery', async t => {
  for (const [failure, error, finalInventory] of [
    ['full-v0', /admission is unverified/, false],
    ['inventory-before', /inventory is unverified/, false],
    ['upload', /Reconcile staging before retrying/, true],
    ['record-d1', /recovery record is unverified/, true],
    ['record-worker', /recovery record is unverified/, true],
  ]) {
    const { run, events } = lifecycle(t, failure);
    await assert.rejects(run(), error);
    assert.deepEqual(events, [...successOrder.slice(0, successOrder.indexOf(failure) + 1),
      ...(finalInventory ? ['inventory-after'] : [])]);
  }
});

test('qualification lifecycle blocks D1 apply and Worker activation on exact-record readback drift', async t => {
  for (const kind of ['d1', 'worker']) {
    const { run, events } = lifecycle(t, undefined, kind);
    await assert.rejects(run(), invalidRecord);
    assert.deepEqual(events, [...successOrder.slice(0, successOrder.indexOf(`read-${kind}`) + 1), 'inventory-after']);
  }
});

test('qualification failures and cancellation suppress the result without skipping recovery', async t => {
  for (const [failure, error] of [
    ['exercise', /Case failed/], ['cancel', { name: 'AbortError' }], ['cleanup', /prefix cleanup is unverified/],
    ['inventory-after', /inventory is unverified/], ['cancel-after-restore', { name: 'AbortError' }],
  ]) {
    const { run, events } = lifecycle(t, failure);
    await assert.rejects(run(), error);
    assert.deepEqual(events, successOrder);
  }
  const { run, events } = lifecycle(t, 'probe');
  await assert.rejects(run(), /Readiness failed/);
  assert.deepEqual(events, [...successOrder.slice(0, successOrder.indexOf('probe') + 1), 'restore', 'inventory-after']);
});

test('final inventory failure preserves Worker rollback reconciliation', async t => {
  const { run, events } = lifecycle(t, ['restore', 'inventory-after']);
  await assert.rejects(run(), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /rollback is unverified; reconcile/);
    assert.match(error.errors[1].message, /inventory is unverified \(after\)/);
    return true;
  });
  assert.deepEqual(events, successOrder);
});

const r2Attempt = { runId: '182', attempt: '3', prefix: 'drive-qualification/full-v0/182/3/' };
const r2Key = `${r2Attempt.prefix}fixture`;

function r2Fixture({ pending = { uploads: [{ key: r2Key, uploadId: 'fixture-upload' }] },
  objects = { keys: [r2Key] }, afterUploads = { uploads: [] }, afterObjects = { keys: [] }, status = 204 } = {}) {
  const trace = [];
  const list = (kind, first, after) => async ({ prefix, verifyScope, signal }) => {
    assert.equal(prefix, r2Attempt.prefix);
    assert.equal(verifyScope, true);
    assert.equal(signal.aborted, false);
    const seen = trace.includes(kind);
    trace.push(kind);
    return seen ? after : first;
  };
  return { trace, io: { listing: { uploads: list('uploads', pending, afterUploads), objects: list('objects', objects, afterObjects) },
    request: async ({ method, key, query, signal }) => {
      assert.equal(method, 'DELETE');
      assert.equal(signal.aborted, false);
      trace.push([key, query]);
      return { status };
    } } };
}

test('R2 cleanup validates both lists before deleting and proves the exact prefix empty', async () => {
  const { trace, io } = r2Fixture();
  assert.equal(await cleanQualificationR2(r2Attempt, undefined, io), true);
  assert.deepEqual(trace, ['uploads', 'objects', [r2Key, { uploadId: 'fixture-upload' }], [r2Key, undefined], 'uploads', 'objects']);
});

test('R2 cleanup refuses unsafe or partial snapshots before the first mutation', async () => {
  const invalid = [
    { objects: { keys: [r2Key, r2Key.replace('/182/3/', '/182/30/')] } },
    { objects: { keys: [`${r2Attempt.prefix}../sibling`] } },
    { objects: { keys: [r2Key, r2Key] } },
    { objects: { keys: [], nextContinuationToken: 'partial' } },
    { pending: { uploads: [], nextKeyMarker: r2Key, nextUploadIdMarker: 'partial' } },
    { pending: { uploads: [{ key: r2Key, uploadId: '' }] } },
    { objects: { keys: Array.from({ length: 100 }, (_, i) => `${r2Key}-${i}`) } },
  ];
  for (const options of invalid) {
    const { trace, io } = r2Fixture(options);
    await assert.rejects(cleanQualificationR2(r2Attempt, undefined, io), /cleanup is unverified/);
    assert.deepEqual(trace, ['uploads', 'objects']);
  }
  const { trace, io } = r2Fixture();
  await assert.rejects(cleanQualificationR2({ ...r2Attempt, prefix: 'drive-qualification/' }, undefined, io), /cleanup is unverified/);
  await assert.rejects(cleanQualificationR2({ ...r2Attempt, attempt: '../3' }, undefined, io), /Invalid qualification run or attempt/);
  assert.deepEqual(trace, []);
});

test('R2 cleanup withholds success on leftovers, failed deletion or cancellation', async () => {
  for (const options of [{ afterObjects: { keys: [r2Key] } },
    { afterUploads: { uploads: [{ key: r2Key, uploadId: 'late-upload' }] } }, { status: 403 }]) {
    await assert.rejects(cleanQualificationR2(r2Attempt, undefined, r2Fixture(options).io), /cleanup is unverified/);
  }
  const controller = new AbortController();
  const { trace, io } = r2Fixture();
  io.request = async () => { trace.push('request settled'); controller.abort(); return { status: 204 }; };
  await assert.rejects(cleanQualificationR2(r2Attempt, controller.signal, io), /cleanup is unverified/);
  assert.deepEqual(trace, ['uploads', 'objects', 'request settled']);
});

function multipartFixture({ bad = '', stop } = {}) {
  const trace = [];
  const parts = new Map();
  const uploadId = 'synthetic-upload', etag = '"stored"', partBytes = 8;
  const key = `${r2Attempt.prefix}provider-multipart-fixture`;
  let stored;
  let writes = 0;
  function record(step, actualKey, signal) {
    assert.equal(actualKey, key);
    signal.throwIfAborted();
    trace.push(step);
  }
  return { trace, io: { partBytes,
    async head(key, { ifMatch, signal }) {
      record(ifMatch ? 'head' : 'empty', key, signal);
      if (!ifMatch) return { status: bad === 'preexisting' ? 200 : 404 };
      assert.equal(ifMatch, etag);
      return { status: 200, etag: bad === 'generation' ? '"other"' : etag, contentLength: String(stored.length) };
    },
    async create(key, signal) {
      record('create', key, signal);
      if (bad === 'ambiguous-create') throw new Error('private provider diagnostic');
      return { uploadId };
    },
    async upload(key, id, partNumber, bytes, signal) {
      record(`part ${partNumber}`, key, signal);
      assert.equal(id, uploadId);
      writes++;
      const hash = bad === 'unchanged-ack' ? 0 : bad === 'retry-drift' && writes === 3 ? 1 : bytes[0];
      const etag = `"part-${partNumber}-${hash}"`;
      if (!(bad === 'dropped-seed' && writes === 1) && !(bad === 'no-replacement' && parts.has(partNumber))) {
        parts.set(partNumber, { partNumber, bytes: Buffer.from(bytes), etag });
      }
      return { partNumber, etag, size: bytes.length };
    },
    async listParts(key, id, { partNumberMarker, maxParts, signal }) {
      record('list', key, signal);
      assert.equal(id, uploadId);
      assert.equal(maxParts, 1);
      const part = parts.get((partNumberMarker ?? 0) + 1);
      if (!part) return { parts: [] };
      const { partNumber, bytes, etag } = part;
      const listed = { partNumber, size: bytes.length, etag };
      if (writes === 1) {
        if (bad === 'seed-part-number') listed.partNumber = 2;
        if (bad === 'seed-size') listed.size--;
        if (bad === 'seed-etag') listed.etag = '"unexpected"';
      }
      if (bad === 'listed-etag' && writes === 4 && partNumber === 2) listed.etag = '"unexpected"';
      return { parts: [listed], nextPartNumberMarker: parts.has(partNumber + 1) ? partNumber : undefined };
    },
    async complete(key, id, manifest, signal) {
      record('complete', key, signal);
      assert.equal(id, uploadId);
      assert.deepEqual(manifest.map(part => part.partNumber), [1, 2]);
      stored = Buffer.concat(manifest.map(part => {
        const source = parts.get(part.partNumber);
        assert.equal(part.etag, source.etag);
        return source.bytes;
      }));
      if (bad === 'ambiguous-complete') throw new Error('private provider diagnostic');
      return { etag };
    },
    async request({ method, key, headers, maxResponseBytes, signal }) {
      record(headers.range ? 'range' : 'full', key, signal);
      assert.equal(method, 'GET');
      assert.equal(headers['if-match'], etag);
      const ranged = Boolean(headers.range);
      if (ranged) assert.equal(headers.range, 'bytes=6-9');
      const body = Buffer.from(!ranged ? stored : bad === 'wrong-range-offset'
        // Preserve the two bytes per part, length and headers but read the wrong offsets.
        ? Buffer.concat([stored.subarray(0, 2), stored.subarray(10, 12)]) : stored.subarray(6, 10));
      assert.equal(maxResponseBytes, body.length);
      if (bad === 'range' && ranged || bad === 'content' && !ranged) body[0] ^= 1;
      if (ranged) stop?.abort();
      return { status: ranged ? 206 : 200, body, headers: new Headers({ etag, 'content-length': String(body.length),
        ...(ranged ? { 'content-range': 'bytes 6-9/265' } : {}) }) };
    },
  } };
}

const seedTrace = ['empty', 'create', 'part 1', 'list'];
const manifestTrace = [...seedTrace, 'part 1', 'part 1', 'part 2', 'list', 'list'];
const readbackTrace = [...manifestTrace, 'complete', 'head', 'full', 'range'];

test('provider storage cases require a part replacement and exact full and ranged readback', async () => {
  const { trace, io } = multipartFixture();
  assert.deepEqual(await exerciseQualificationStorage(r2Attempt, undefined, io), {
    's3-multipart': 'pass', 's3-range': 'pass', 's3-retry': 'pass', 's3-persistence': 'pass',
  });
  assert.deepEqual(trace, readbackTrace);
});

for (const [bad, expectedTrace] of [
  ['preexisting', ['empty']],
  ['ambiguous-create', ['empty', 'create']],
  ['dropped-seed', seedTrace],
  ['seed-part-number', seedTrace],
  ['seed-size', seedTrace],
  ['seed-etag', seedTrace],
  ['unchanged-ack', manifestTrace.slice(0, 6)],
  ['retry-drift', manifestTrace.slice(0, 6)],
  ['no-replacement', manifestTrace.slice(0, 8)],
  ['listed-etag', manifestTrace],
  ['ambiguous-complete', [...manifestTrace, 'complete']],
  ['generation', readbackTrace.slice(0, -2)],
  ['content', readbackTrace.slice(0, -1)],
  ['range', readbackTrace],
  ['wrong-range-offset', readbackTrace],
]) {
  test(`provider storage cases fail closed: ${bad}`, async () => {
    const { trace, io } = multipartFixture({ bad });
    await assert.rejects(exerciseQualificationStorage(r2Attempt, undefined, io), { message: 'Qualification S3 cases are unverified.' });
    assert.deepEqual(trace, expectedTrace);
  });
}

test('provider storage cases fail closed on cancellation or a mismatched prefix', async () => {
  const stop = new AbortController();
  const { trace, io } = multipartFixture({ stop });
  await assert.rejects(exerciseQualificationStorage(r2Attempt, stop.signal, io), /cases are unverified/);
  assert.deepEqual(trace, readbackTrace);
  trace.length = 0;
  await assert.rejects(exerciseQualificationStorage({ ...r2Attempt, prefix: 'drive-qualification/' }, undefined, io), /cases are unverified/);
  assert.deepEqual(trace, []);
});

test('the staged workflow has no producer or provider path', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-qualification.yml', import.meta.url), 'utf8');
  const gate = "github.repository == 'TogetherWeOwn/qerith' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'";
  const [name, trigger, permissions, ...jobs] = workflow.trimEnd().split('\n\n');
  assert.equal(trigger, `on:
  workflow_dispatch:
    inputs:
      tested_sha:
        description: Lowercase 40-hex SHA of the dispatch head on main
        required: true
        type: string`);
  assert.equal(permissions, 'permissions:\n  contents: read');
  assert.equal(name, 'name: Drive staging qualification');
  const jobBlocks = jobs.join('\n\n').split('\n\n  qualification:\n');
  assert.equal(jobBlocks.length, 2);
  const splitSteps = job => {
    const sections = job.split('\n    steps:\n');
    assert.equal(sections.length, 2);
    return sections;
  };
  const [sourceHeader, sourceSteps] = splitSteps(jobBlocks[0]);
  assert.equal(sourceHeader, `jobs:
  # Validate before entering the shared queue: even non-preempting jobs can replace pending jobs.
  source:
    if: ${gate}
    runs-on: ubuntu-latest
    timeout-minutes: 5`);
  const [qualificationHeader, qualificationSteps] = splitSteps(jobBlocks[1]);
  assert.equal(qualificationHeader, `    needs: source
    if: success() && !cancelled() && needs.source.result == 'success' && ${gate}
    concurrency:
      group: drive-staging-lifecycle
      cancel-in-progress: false
    environment: staging
    runs-on: ubuntu-latest
    timeout-minutes: 5`);
  assert.equal(sourceSteps, `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false
      - name: Verify exact dispatch source before staging approval
        env:
          TESTED_SHA: \${{ inputs.tested_sha }}
        run: timeout --signal=TERM --kill-after=5s 30s node apps/drive/scripts/staging-qualification.mjs`);
  assert.equal(qualificationSteps, `      - name: Fail closed until the live runner and cleanup are reviewed
        run: |
          printf '%s\\n' 'Full-v0 staging qualification is not wired; no receipt can be issued.' >&2
          exit 1`);
});
