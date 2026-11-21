import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test as nodeTest } from 'node:test';
import { exerciseQualificationDeletion } from './staging-qualification-deletion.mjs';
import { qualificationPrefix } from './staging-qualification.mjs';

// The composition test imports the fixture without re-registering this suite.
const test = import.meta.main ? nodeTest : () => {};
export { fixture as deletionFixture };

const run = { runId: '23', attempt: '2' };
const context = { ...run, prefix: qualificationPrefix(run) };
const fixtureScope = { endpoint: 'https://storage.example.test', bucket: 'fixture-bucket', epoch: 'fixture-epoch' };
const bytes = Buffer.from([0, 17, 255]);
const tag = data => `"${createHash('md5').update(data).digest('hex')}"`;
const etag = tag(bytes), wrongEtag = tag(Buffer.from([1]));
const statusFor = new Map([
  ['signed-out', 401], ['revoked', 401], ['non-owner', 404], ['missing-origin', 403], ['wrong-origin', 403],
  ['wrong-method', 405], ['invalid-id', 400], ['missing-confirmation', 400], ['invalid-confirmation', 400],
]);
const response = status => new Response(null, { status, headers: { 'cache-control': 'private, no-store',
  ...(status === 405 && { allow: 'POST' }) } });

// In-memory doubles only; no app admission, network, credential or provider prerequisite.
function fixture({ scope = fixtureScope, prefix = context.prefix } = {}) {
  const trees = new Map(), actions = [], probeCalls = [];
  let probePresent = false, now = 42;
  const settle = (state, confirmed) => {
    const { key, job } = state;
    state.calls.push({ method: 'DELETE', key, ifMatch: job.generation.etag, scope,
      outcome: confirmed ? 'deleted' : 'unconfirmed' });
    job.availableAt = now + 300;
    if (confirmed) {
      job.completedAt = now;
      job.completionToken = randomUUID();
      state.object = { status: 404, code: 'NoSuchKey', key, scope };
    }
  };
  const io = {
    scope,
    seed({ entries, key, scope: targetScope, pinned }) {
      assert.deepEqual(targetScope, scope);
      assert.ok(key.startsWith(prefix) && !trees.has(key));
      const revision = pinned ? randomUUID() : null;
      const generation = { ...scope, key, etag, revision, entryId: entries.at(-1).id };
      trees.set(key, { entries, live: entries, key, pinned, generation, journal: [], calls: [],
        journalFaults: [], job: null, publicationTombstoned: false,
        object: { status: 200, key, etag, scope } });
      return { etag, revision };
    },
    inspect({ generation }) { return { ...structuredClone(trees.get(generation.key)), now }; },
    advanceRetryClock(retryAt) { assert.ok(retryAt > now); now = retryAt; },
    remove(id, scenario) {
      actions.push(scenario);
      if (statusFor.has(scenario)) return response(statusFor.get(scenario));
      const state = [...trees.values()].find(tree => tree.live.some(entry => entry.id === id));
      assert.ok(state, 'only owned live IDs may reach the delete client');
      const depth = new Map();
      for (const entry of state.live) {
        if (entry.id === id) depth.set(id, 0);
        else if (depth.has(entry.parent)) depth.set(entry.id, depth.get(entry.parent) + 1);
      }
      if (depth.size > 128 || [...depth.values()].some(value => value > 32) || !state.pinned) return response(404);
      const deletionId = randomUUID();
      const live = state.live.filter(entry => !depth.has(entry.id));
      const journal = [...depth.keys()].map(entryId => ({ entryId, deletionId }));
      if (scenario === 'journal-failure') {
        state.journalFaults.push({ operation: 'journal-insert', entryId: journal[0].entryId });
        return response(503);
      }
      state.journal.push(...journal);
      state.live = live;
      state.publicationTombstoned = true;
      state.job = { generation: state.generation, leaseToken: null, completedAt: null, completionToken: null };
      settle(state, scenario !== 'provider-unconfirmed');
      return response(202);
    },
    retry({ deletionId, generation }) {
      const state = trees.get(generation.key);
      assert.deepEqual(state.job.generation, generation);
      assert.equal(state.journal[0].deletionId, deletionId);
      assert.equal(state.job.completedAt, null);
      assert.ok(state.job.availableAt <= now);
      settle(state, true);
    },
    drainEligible() {
      for (const state of trees.values()) {
        if (state.job?.completedAt === null && state.job.availableAt <= now) settle(state, true);
      }
    },
    seedProbe({ key, scope: targetScope }) {
      assert.deepEqual(targetScope, scope);
      assert.equal(key, `${prefix}delete-provider-proof`);
      probePresent = true;
      return { key, scope: targetScope, bytes, etag, wrongEtag, versioning: 'never-enabled', readConsistency: 'authoritative' };
    },
    requestProbe({ method, key, scope: targetScope, headers, cache, signal }) {
      signal.throwIfAborted();
      assert.deepEqual(targetScope, scope);
      assert.equal(key, `${prefix}delete-provider-proof`);
      const match = headers?.['if-match'];
      probeCalls.push([method, match, cache]);
      const result = (status, body, headers = {}) => ({ status, body: Buffer.from(body), headers: new Headers(headers) });
      const error = (status, code) => result(status, `<Error><Code>${code}</Code><Key>${key}</Key></Error>`);
      if (method === 'GET') return probePresent ? result(200, bytes, { etag }) : error(404, 'NoSuchKey');
      if (match !== etag) return error(412, 'PreconditionFailed');
      probePresent = false;
      return result(204, '');
    },
  };
  return { io, actions, trees, probeCalls };
}

test('verifies all four deletion cases using only owned fixtures and injected clients', async () => {
  const { io, actions, probeCalls } = fixture();
  assert.deepEqual(await exerciseQualificationDeletion(context, undefined, fixtureScope, io), {
    'delete-envelope': 'pass', 'delete-boundary-and-safe-fallback': 'pass',
    'delete-rollback-and-retry': 'pass', 'delete-provider-proof': 'pass',
  });
  assert.deepEqual(actions.slice(0, statusFor.size), [...statusFor.keys()]);
  assert.deepEqual(probeCalls, [['GET', etag, 'no-store'], ['DELETE', wrongEtag, undefined],
    ['GET', etag, 'no-store'], ['DELETE', etag, undefined], ['GET', undefined, 'no-store']]);
});

test('accepts reordered journal rows before and after scoped retry', async () => {
  const { io } = fixture();
  const inspect = io.inspect;
  io.inspect = tree => {
    const state = inspect(tree);
    if (state.key.endsWith('delete-recovery') && state.job?.completionToken) state.journal.reverse();
    return state;
  };
  const result = await exerciseQualificationDeletion(context, undefined, fixtureScope, io);
  assert.equal(result['delete-rollback-and-retry'], 'pass');
});

test('refuses to invoke retry when the injected clock does not advance', async () => {
  const { io } = fixture();
  let retryCalls = 0;
  io.advanceRetryClock = () => {};
  io.retry = () => { retryCalls++; };
  await assert.rejects(exerciseQualificationDeletion(context, undefined, fixtureScope, io), /\(delete-rollback-and-retry\)/);
  assert.equal(retryCalls, 0);
});

for (const [name, phase, corrupt] of [
  ['denied response leaks a body', 'envelope', ({ io }) => {
    io.remove = () => new Response('leak', { status: 401, headers: { 'cache-control': 'private, no-store' } });
  }],
  ['cross-user denial makes a provider call', 'envelope', ({ io, trees }) => {
    const remove = io.remove;
    io.remove = (id, scenario) => {
      if (scenario === 'non-owner') trees.get(`${context.prefix}delete-envelope`).calls.push({ method: 'DELETE' });
      return remove(id, scenario);
    };
  }],
  ['missing primary observation', 'envelope', ({ io }) => { io.inspect = () => undefined; }],
  ['overflow rejection hides a partial delete', 'boundary-and-safe-fallback', ({ trees, io }) => {
    const remove = io.remove;
    io.remove = (...args) => {
      const res = remove(...args);
      const state = trees.get(`${context.prefix}delete-count-over`);
      if (res.status === 404 && state) state.live = state.live.slice(1);
      return res;
    };
  }],
  ['rollback leaves a partial journal', 'rollback-and-retry', ({ io, actions }) => {
    const inspect = io.inspect;
    io.inspect = tree => {
      const state = inspect(tree);
      if (actions.at(-1) === 'journal-failure') state.journal.push({ entryId: state.entries[0].id });
      return state;
    };
  }],
  ['an early 503 never reaches the journal fault', 'rollback-and-retry', ({ io }) => {
    const remove = io.remove;
    io.remove = (id, scenario) => scenario === 'journal-failure' ? response(503) : remove(id, scenario);
  }],
  ['retry drains another eligible attempt-owned job', 'rollback-and-retry', ({ io }) => {
    const retry = io.retry;
    io.retry = input => { retry(input); io.drainEligible(); };
  }],
  ['first delete attempt has no observed provider outcome', 'rollback-and-retry', ({ io }) => {
    const inspect = io.inspect;
    io.inspect = tree => {
      const state = inspect(tree);
      if (state.calls[0]?.outcome === 'unconfirmed') delete state.calls[0].outcome;
      return state;
    };
  }],
  ['retry completes the job despite an unconfirmed provider reply and later absence', 'rollback-and-retry', ({ io, trees }) => {
    const retry = io.retry;
    io.retry = input => { retry(input); trees.get(input.generation.key).calls[1].outcome = 'unconfirmed'; };
  }],
  ['retry settles another generation', 'rollback-and-retry', ({ io, trees }) => {
    const retry = io.retry;
    io.retry = input => { retry(input); trees.get(input.generation.key).job.generation.revision = 'other'; };
  }],
  ['retry changes the deletion journal identity', 'rollback-and-retry', ({ io, trees }) => {
    const retry = io.retry;
    io.retry = input => {
      retry(input);
      for (const row of trees.get(input.generation.key).journal) row.deletionId = 'other';
    };
  }],
  ['retry has no completion observation', 'rollback-and-retry', ({ io, trees }) => {
    const retry = io.retry;
    io.retry = input => { retry(input); delete trees.get(input.generation.key).job.completionToken; };
  }],
  ['probe scope mismatch', 'provider-proof', ({ io }) => {
    const seed = io.seedProbe;
    io.seedProbe = input => ({ ...seed(input), scope: { ...fixtureScope, epoch: 'other' } });
  }],
  ['probe absence names a different key', 'provider-proof', ({ io }) => {
    const send = io.requestProbe;
    io.requestProbe = input => {
      const res = send(input);
      return res.status !== 404 ? res : { ...res, body: Buffer.from('<Error><Code>NoSuchKey</Code><Key>other</Key></Error>') };
    };
  }],
  ['probe absence read is missing', 'provider-proof', ({ io }) => {
    const send = io.requestProbe;
    io.requestProbe = input => input.method === 'GET' && !input.headers ? undefined : send(input);
  }],
]) {
  test(`rejects ${name}`, async () => {
    const setup = fixture();
    corrupt(setup);
    await assert.rejects(exerciseQualificationDeletion(context, undefined, fixtureScope, setup.io), new RegExp(`\\(delete-${phase}\\)`));
    if (name === 'probe scope mismatch') assert.equal(setup.probeCalls.length, 0);
  });
}

test('rejects another attempt prefix and cancellation before fixture work', async () => {
  const { io, trees, probeCalls } = fixture();
  const signal = AbortSignal.abort();
  await assert.rejects(exerciseQualificationDeletion({ ...context, prefix: qualificationPrefix({ ...run, attempt: '1' }) },
    undefined, fixtureScope, io), /\(scope\)/);
  await assert.rejects(exerciseQualificationDeletion(context, signal, fixtureScope, io), /\(scope\)/);
  assert.equal(trees.size + probeCalls.length, 0);
});
