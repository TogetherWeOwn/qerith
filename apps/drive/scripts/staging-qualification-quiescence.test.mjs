import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyQualificationQuiescence } from './staging-qualification-quiescence.mjs';

const start = 1_800_000_000_000;
const identity = { sha: 'a'.repeat(40), runId: '182', attempt: '30' };
const source = { ...identity, version: 'ab123456-7890-1234-5678-1234567890ab', expiresAt: String(start + 10) };
const unverified = { message: 'Qualification writer quiescence is unverified.' };
const proof = (state, offset) => ({ state, at: start + offset });

function provider(current = source) {
  return {
    observedAt: start + 60,
    fence: { since: start, until: start + 100, coverage: 'exclusive', superseded: false, current: { ...identity } },
    runner: proof('settled', 5),
    candidate: { ...proof('fenced', 6), version: current.version, expiresAt: current.expiresAt },
    inFlight: proof('settled', 20),
    storageUrls: proof('fenced', 30),
    storageInFlight: proof('settled', 40),
    providerOperations: proof('settled', 50),
  };
}
const verify = (snapshot, offset = 60, signal) =>
  verifyQualificationQuiescence(source, snapshot, { now: () => start + offset, signal });

test('cooperative cancellation can use bounded proof under a separate cleanup signal', () => {
  const cases = new AbortController();
  cases.abort();
  assert.throws(() => verify(provider(), 60, cases.signal), { name: 'AbortError' });
  const cleanup = new AbortController();
  const result = verify(provider(), 60, cleanup.signal);
  assert.deepEqual(result, { ...identity, version: source.version, verifiedAt: start + 60, validUntil: start + 100 });
  assert.ok(Object.isFrozen(result));
  cleanup.abort();
  assert.throws(() => verify(provider(), 60, cleanup.signal), { name: 'AbortError' });
  assert.throws(() => verify(provider(), 100), unverified);
});

test('lost runner needs positive provider proof beyond candidate and URL expiry', () => {
  const snapshot = provider();
  snapshot.runner = proof('fenced', 5);
  snapshot.candidate = { ...snapshot.candidate, ...proof('expired', 10) };
  snapshot.storageUrls = { ...proof('expired', 30), latestExpiry: start + 30 };
  assert.equal(verify(snapshot).attempt, source.attempt);
  for (const patch of [
    { runner: proof('lost', 5) },
    { candidate: { ...snapshot.candidate, at: start + 9 } },
    { inFlight: proof('settled', 9) },
    { runner: proof('settled', 21) }, // Admission closed at 10, but the drain at 20 preceded runner settlement.
    { inFlight: [] },
    { candidate: { ...snapshot.candidate, state: 'open' } },
    { candidate: { ...snapshot.candidate, version: 'bb123456-7890-1234-5678-1234567890ab' } },
    { storageUrls: { ...snapshot.storageUrls, state: 'open' } },
    { storageUrls: proof('expired', 30) },
    { storageUrls: { ...snapshot.storageUrls, at: start + 29 } },
    { storageUrls: { ...proof('expired', 19), latestExpiry: start + 18 } },
    { storageInFlight: proof('pending', 40) },
    { storageInFlight: proof('settled', 29) },
    { providerOperations: proof('settled', 39) },
    { providerOperations: proof('pending', 50), baseline: 'observed' },
    { providerOperations: proof('settled', 61) },
    { providerOperations: [] },
  ]) assert.throws(() => verify({ ...snapshot, ...patch }, 99), unverified, Object.keys(patch).join('+'));
});

test('unknown coverage, supersession and mismatched or stale attempt evidence fail closed', () => {
  const snapshot = provider();
  for (const patch of [
    { coverage: 'unknown' }, { superseded: true }, { superseded: undefined },
    ...[ ['sha', 'b'.repeat(40)], ['runId', '183'], ['attempt', '31'] ].map(([key, value]) =>
      ({ current: { ...identity, [key]: value } })),
    { since: start + 6 },
  ]) assert.throws(() => verify({ ...snapshot, fence: { ...snapshot.fence, ...patch } }), unverified);
  assert.throws(() => verify({ ...snapshot, candidate: { ...snapshot.candidate, expiresAt: String(start + 11) } }), unverified);
  assert.throws(() => verify(snapshot, 59), unverified);
  assert.throws(() => verify(snapshot, NaN), unverified);
});

test('missing candidate record does not prove the candidate never admitted a request', () => {
  const preActivation = { ...identity, version: null, expiresAt: null };
  const snapshot = provider(preActivation);
  const check = candidate => verifyQualificationQuiescence(preActivation, { ...snapshot, candidate },
    { now: () => start + 60 });
  assert.throws(() => check(undefined), unverified);
  assert.throws(() => check(snapshot.candidate), unverified);
  assert.equal(check({ ...snapshot.candidate, state: 'never-admitted' }).version, null);
});
