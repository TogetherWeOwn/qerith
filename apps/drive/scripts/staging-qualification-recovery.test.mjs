import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverQualification } from './staging-qualification-recovery.mjs';

const source = { sha: 'a'.repeat(40), runId: '9007199254740993', attempt: '2' };
const prefix = 'drive-qualification/full-v0/9007199254740993/2/';
const admitted = {
  ...source, repository: 'TogetherWeOwn/qerith', headRepository: 'TogetherWeOwn/qerith',
  workflow: '.github/workflows/drive-staging-qualification.yml', ref: 'refs/heads/main',
  event: 'workflow_dispatch', status: 'completed', conclusion: 'failure',
  sourceJobConclusion: 'success', latestAttempt: '2',
};
const uuid = n => `00000000-0000-0000-0000-00000000000${n}`;
const records = {
  d1: { ...source, kind: 'd1', bookmark: 'pre_apply' },
  worker: { ...source, kind: 'worker', version: uuid(1), previousVersion: uuid(2),
    previousDeployment: uuid(3), expiresAt: '1780000000000' },
};
const restored = { status: 'restored', version: uuid(2), deployment: uuid(4) };
const original = { status: 'baseline-observed', version: uuid(2), deployment: uuid(3) };
const trace = ['source', 'read:d1', 'read:worker', 'guard', 'worker', 'D1', 'R2'];

function fixture() {
  const calls = [];
  const step = (name, signal) => {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    calls.push(name);
  };
  return { calls, adapters: {
    async readSource(identity, signal) {
      assert.deepEqual(identity, source);
      step('source', signal);
      return admitted;
    },
    async readRecord(identity, kind, signal) {
      assert.deepEqual(identity, source);
      step(`read:${kind}`, signal);
      return records[kind];
    },
    async proveWriters(context, evidence, signal) {
      assert.deepEqual(context, { ...source, prefix });
      assert.deepEqual(evidence, records);
      step('guard', signal);
      return true;
    },
    async recoverWorker(identity, record, signal) {
      assert.deepEqual(identity, source);
      assert.deepEqual(record, records.worker);
      step('worker', signal);
      return restored;
    },
    async recoverD1(identity, record, signal) {
      assert.deepEqual(identity, source);
      assert.deepEqual(record, records.d1);
      step('D1', signal);
      return true;
    },
    async cleanupR2(context, signal) {
      assert.deepEqual(context, { ...source, prefix });
      step('R2', signal);
      return true;
    },
  } };
}

const override = (adapters, name, replace) => {
  const original = adapters[name];
  adapters[name] = async (...args) => replace(await original(...args), ...args);
};

test('recovers in order for failed, cancelled and lost attempts without issuing a receipt', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const { adapters, calls } = fixture();
    override(adapters, 'readSource', evidence => ({ ...evidence, conclusion }));
    if (conclusion === 'timed_out') override(adapters, 'recoverWorker', () => original);
    assert.equal(await recoverQualification({ ...source, prefix: 'not-the-source-prefix' }, adapters), undefined);
    assert.deepEqual(calls, trace);
  }
});

test('rejects invalid request identities or missing adapters before reading evidence', async () => {
  const { adapters, calls } = fixture();
  for (const invalid of [{ sha: 'A'.repeat(40) }, { runId: 1 }, { attempt: '02' }]) {
    await assert.rejects(recoverQualification({ ...source, ...invalid }, adapters), /\(input\)/);
  }
  await assert.rejects(recoverQualification(source, { ...adapters, cleanupR2: null }), /\(input\)/);
  assert.deepEqual(calls, []);
});

test('rejects every mismatched or ineligible source before reading records', async () => {
  for (const [field, value] of Object.entries({
    sha: 'b'.repeat(40), runId: '9007199254740992', attempt: '1', latestAttempt: '3',
    repository: 'other/qerith', headRepository: 'other/qerith', workflow: '.github/workflows/another.yml',
    ref: 'refs/heads/preview', event: 'pull_request', status: 'in_progress', conclusion: 'success',
    sourceJobConclusion: 'skipped',
  })) {
    const { adapters, calls } = fixture();
    override(adapters, 'readSource', evidence => ({ ...evidence, [field]: value }));
    await assert.rejects(recoverQualification(source, adapters), /\(source\)/, field);
    assert.deepEqual(calls, ['source'], field);
  }
});

test('refuses absent, copied, wrong-kind and incomplete records before writer proof', async () => {
  for (const [kind, replacement] of [
    ['d1', null], ['d1', { ...records.d1, bookmark: '' }], ['worker', undefined],
    ['worker', { ...records.worker, kind: 'd1' }], ['worker', { ...records.worker, attempt: '1' }],
    ['worker', { ...records.worker, previousVersion: records.worker.version }],
  ]) {
    const { adapters, calls } = fixture();
    override(adapters, 'readRecord', (record, _, requested) => requested === kind ? replacement : record);
    await assert.rejects(recoverQualification(source, adapters), new RegExp(`\\(${kind} record\\)`));
    assert.deepEqual(calls, trace.slice(0, kind === 'd1' ? 2 : 3));
  }
});

test('baseline cannot substitute for proof against late activation or superseding writers', async () => {
  for (const blocked of ['pending activation', 'superseding writer', 'ambiguous proof']) {
    const { adapters, calls } = fixture();
    override(adapters, 'proveWriters', () => blocked === 'ambiguous proof' ? { allowed: true } : false);
    override(adapters, 'recoverWorker', () => original);
    await assert.rejects(recoverQualification(source, adapters), /\(writer quiescence\)/, blocked);
    assert.deepEqual(calls, trace.slice(0, 4));
  }
});

test('halts without retry on an ambiguous restore, D1 recovery or unverified R2 cleanup', async () => {
  for (const [name, phase, count, replacement] of [
    ['recoverWorker', 'Worker restore', 5, undefined],
    ['recoverWorker', 'Worker restore', 5, { ...original, deployment: uuid(4) }],
    ['recoverWorker', 'Worker restore', 5, { ...restored, version: uuid(1) }],
    ['recoverWorker', 'Worker restore', 5, new Error('private provider diagnostic')],
    ['recoverD1', 'D1 recovery', 6, { restored: true }], ['cleanupR2', 'R2 cleanup', 7, false],
  ]) {
    const { adapters, calls } = fixture();
    override(adapters, name, () => {
      if (replacement instanceof Error) throw replacement;
      return replacement;
    });
    await assert.rejects(recoverQualification(source, adapters), {
      message: `Staging qualification recovery is unverified (${phase}).`,
    });
    assert.deepEqual(calls, trace.slice(0, count));
  }
});

test('cancellation never starts the next phase and is not certified even after cleanup', async () => {
  for (const [index, name] of ['readSource', 'readRecord', 'readRecord', 'proveWriters',
    'recoverWorker', 'recoverD1', 'cleanupR2'].entries()) {
    const { adapters, calls } = fixture();
    const controller = new AbortController();
    override(adapters, name, result => {
      if (calls.length === index + 1) controller.abort(new Error('private abort reason'));
      return result;
    });
    await assert.rejects(recoverQualification(source, adapters, controller.signal), /is unverified/);
    assert.deepEqual(calls, trace.slice(0, index + 1));
  }
  const { adapters, calls } = fixture();
  await assert.rejects(recoverQualification(source, adapters, AbortSignal.abort()), /\(source\)/);
  assert.deepEqual(calls, []);
});

test('phase deadline aborts in-flight work, waits for it to drain and never starts recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { adapters, calls } = fixture();
  const started = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const drained = Promise.withResolvers();
  override(adapters, 'proveWriters', async (_, context, evidence, signal) => {
    signal.addEventListener('abort', aborted.resolve, { once: true });
    started.resolve();
    await drained.promise;
    return true;
  });
  const run = recoverQualification(source, adapters);
  let settled = false;
  const rejection = assert.rejects(run.finally(() => { settled = true; }), /\(writer quiescence\)/);
  await started.promise;
  t.mock.timers.tick(30_000);
  await aborted.promise;
  assert.equal(settled, false);
  assert.deepEqual(calls, trace.slice(0, 4));
  drained.resolve();
  await rejection;
  assert.deepEqual(calls, trace.slice(0, 4));
});
