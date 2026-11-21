import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverQualification } from './staging-qualification-recovery.mjs';
import { createQualificationRecoverySource } from './staging-qualification-recovery-source.mjs';

const source = { sha: 'a'.repeat(40), runId: '1234', attempt: '2' };
const repo = 'TogetherWeOwn/qerith';
const attemptPath = '1234/attempts/2';
const paths = [attemptPath, `${attemptPath}/jobs?per_page=10`, '1234'];
const run = { id: 1234, run_attempt: 2, head_sha: source.sha, head_branch: 'main',
  path: '.github/workflows/drive-staging-qualification.yml', repository: { full_name: repo },
  head_repository: { full_name: repo }, event: 'workflow_dispatch', status: 'completed', conclusion: 'failure' };
const job = { name: 'source', status: 'completed', conclusion: 'success', run_id: 1234, run_attempt: 2,
  head_sha: source.sha, steps: [{ name: 'Verify exact dispatch source before staging approval',
    status: 'completed', conclusion: 'success' }] };
const listing = { total_count: 1, jobs: [job] };

function fixture(responses = [run, listing, run]) {
  const calls = [];
  const readSource = createQualificationRecoverySource({ token: 'fixture', async request(url, init) {
    assert.equal(url, `https://api.github.com/repos/${repo}/actions/runs/${paths[calls.length]}`);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer fixture');
    init.signal.throwIfAborted();
    const next = responses[calls.length];
    calls.push(url);
    return next instanceof Response ? next : Response.json(next);
  } });
  return { readSource, calls };
}

async function recover(readSource, records) {
  return recoverQualification(source, { readSource, async readRecord(identity, kind) {
    records.push([identity, kind]);
  }, readWriterFence() {}, recoverWorker() {}, recoverD1() {}, cleanupR2() {} });
}

test('authenticates the exact failed attempt and its source step before recovery records are read', async () => {
  const { readSource, calls } = fixture();
  const records = [];
  await assert.rejects(recover(readSource, records), /\(d1 record\)/);
  assert.equal(calls.length, 3);
  assert.deepEqual(records, [[source, 'd1']]);
});

test('accepts both main workflow path suffixes on either metadata response', async () => {
  for (const [attemptSuffix, latestSuffix] of [['@main', '@refs/heads/main'], ['@refs/heads/main', '@main']]) {
    const { readSource, calls } = fixture([
      { ...run, path: run.path + attemptSuffix }, listing, { ...run, path: run.path + latestSuffix },
    ]);
    const records = [];
    await assert.rejects(recover(readSource, records), /\(d1 record\)/);
    assert.equal(calls.length, 3);
    assert.deepEqual(records, [[source, 'd1']]);
  }
});

test('refuses stale or mismatched attempts and incomplete or ambiguous source jobs before reading records', async () => {
  for (const [responses, count] of [
    [[{ ...run, head_repository: { full_name: 'fork/qerith' } }], 1],
    [[{ ...run, head_sha: 'b'.repeat(40) }], 1],
    [[{ ...run, path: '.github/workflows/other.yml' }], 1],
    [[{ ...run, path: `${run.path}@refs/tags/main` }], 1],
    [[run, listing, { ...run, path: `${run.path}@preview` }], 3],
    [[{ ...run, head_branch: 'preview' }], 1],
    [[{ ...run, event: 'pull_request' }], 1],
    [[new Response(null, { status: 403 })], 1],
    [[run, Response.json(listing, { headers: { link: '<next>; rel="next"' } })], 2],
    [[run, { ...listing, total_count: 2 }], 2],
    [[run, { total_count: 2, jobs: [job, job] }], 2],
    [[run, { ...listing, jobs: [{ ...job, run_attempt: 1 }] }], 2],
    [[run, { ...listing, jobs: [{ ...job, run_attempt: undefined }] }], 2],
    [[run, { ...listing, jobs: [{ ...job, steps: [{ ...job.steps[0], conclusion: 'skipped' }] }] }], 2],
    [[run, listing, { ...run, run_attempt: 3 }], 3],
    [[run, listing, { ...run, status: 'in_progress', conclusion: null }], 3],
  ]) {
    const { readSource, calls } = fixture(responses);
    const records = [];
    await assert.rejects(recover(readSource, records), /\(source\)/);
    assert.equal(calls.length, count);
    assert.deepEqual(records, []);
  }
});

for (const stall of ['headers', 'body']) {
  test(`the request deadline aborts a stalled ${stall} read and drains before the phase deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Node's AbortSignal.timeout uses an internal timer outside the mocked clock.
    t.mock.method(AbortSignal, 'timeout', ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Request timed out.', 'TimeoutError')), ms);
      return controller.signal;
    });
    const started = Promise.withResolvers();
    const drained = Promise.withResolvers();
    const records = [];
    let requestSignal;
    let calls = 0;
    const readSource = createQualificationRecoverySource({ token: 'fixture', async request(_, { signal }) {
      calls++;
      requestSignal = signal;
      const waitForDrain = async () => {
        started.resolve();
        await drained.promise;
        return signal.reason ?? new Error('Fixture transport drained without abort.');
      };
      if (stall === 'headers') throw await waitForDrain();
      return new Response(new ReadableStream({ async pull(body) { body.error(await waitForDrain()); } },
        { highWaterMark: 0 }));
    } });
    let settled = false;
    const result = assert.rejects(recover(readSource, records).finally(() => { settled = true; }), /\(source\)/);
    try {
      await Promise.race([started.promise, result]);
      t.mock.timers.tick(4_999);
      assert.equal(requestSignal.aborted, false);
      t.mock.timers.tick(1);
      assert.equal(requestSignal.reason?.name, 'TimeoutError');
      await new Promise(setImmediate);
      assert.equal(settled, false);
    } finally {
      drained.resolve();
      await result;
    }
    assert.equal(calls, 1);
    assert.deepEqual(records, []);
  });
}

test('rejects oversized source responses and drains cancellation before settling', async () => {
  const drained = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const body = new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(96 * 1024 + 1)); },
    async cancel() { cancelled.resolve(); await drained.promise; } });
  const { readSource, calls } = fixture([new Response(body)]);
  let settled = false;
  const result = assert.rejects(recover(readSource, []).finally(() => { settled = true; }), /\(source\)/);
  await cancelled.promise;
  assert.equal(settled, false);
  drained.resolve();
  await result;
  assert.equal(calls.length, 1);
});
