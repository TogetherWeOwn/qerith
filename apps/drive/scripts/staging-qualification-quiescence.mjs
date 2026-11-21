const invalid = () => new Error('Qualification writer quiescence is unverified.');
const epoch = value => Number.isSafeInteger(value) && value > 0;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);

// Pure policy over authoritative, exact-attempt readback, not a provider probe.
// The protected caller must hold the lifecycle fence through consumption, and
// supply observations from that fence epoch. Exclusive coverage must exclude
// unknown/baseline writers on the affected resources, not just other runs.
// Each barrier is durable: admissions cannot reopen, and settled/fenced work
// cannot commit later. Empty listings, local abort and client timeouts do not
// establish barriers. Provider operations include pending deploys and writes;
// none may reopen an earlier barrier. URL expiry needs a proven upper bound
// covering every issued URL, not an estimate from a nominal TTL. Consumers
// must stop if the holding fence is lost or reaches validUntil.
export function verifyQualificationQuiescence(source, snapshot, { now, signal } = {}) {
  signal?.throwIfAborted();
  const verifiedAt = now?.();
  const { sha, runId, attempt, version, expiresAt } = source ?? {};
  const { fence, observedAt, runner, candidate, inFlight, storageUrls, storageInFlight, providerOperations } = snapshot ?? {};
  if (!matches(sha, /^[0-9a-f]{40}$/) || ![runId, attempt].every(id => matches(id, /^[1-9][0-9]{0,19}$/)) ||
      !(version === null ? expiresAt === null : matches(version, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) &&
        matches(expiresAt, /^[1-9][0-9]{12}$/)) ||
      ![verifiedAt, observedAt, fence?.since, fence?.until].every(epoch) ||
      !(fence.since <= observedAt && observedAt <= verifiedAt && verifiedAt < fence.until) ||
      fence.coverage !== 'exclusive' || fence.superseded !== false ||
      fence.current?.sha !== sha || fence.current?.runId !== runId || fence.current?.attempt !== attempt ||
      candidate?.version !== version || candidate?.expiresAt !== expiresAt) throw invalid();

  const barrier = (proof, after, ...states) => {
    if (!states.includes(proof?.state) || !epoch(proof.at) || proof.at < after || proof.at > observedAt) throw invalid();
    return proof.at;
  };
  const stopped = barrier(runner, fence.since, 'settled', 'fenced');
  // A null version needs positive evidence that no candidate could be admitted.
  const closed = version === null ? barrier(candidate, fence.since, 'never-admitted') :
    barrier(candidate, fence.since, 'expired', 'fenced');
  if (candidate.state === 'expired' && closed < Number(expiresAt)) throw invalid();

  const drained = barrier(inFlight, Math.max(closed, stopped), 'settled', 'fenced');
  // In-flight requests may mint URLs; URL expiry doesn't drain admitted uploads.
  const urlsClosed = barrier(storageUrls, drained, 'expired', 'fenced');
  if (storageUrls.state === 'expired' && (!epoch(storageUrls.latestExpiry) || urlsClosed < storageUrls.latestExpiry)) {
    throw invalid();
  }
  const storageDrained = barrier(storageInFlight, urlsClosed, 'settled', 'fenced');
  barrier(providerOperations, storageDrained, 'settled', 'fenced');
  signal?.throwIfAborted();
  return Object.freeze({ sha, runId, attempt, version, verifiedAt, validUntil: fence.until });
}
