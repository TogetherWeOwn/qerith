import { qualificationPrefix } from './staging-qualification.mjs';

const schema = 'drive-staging-recovery.v1';
export const maxRecordBytes = 2048;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const invalid = () => new Error('Staging qualification recovery record is unverified.');

function scope({ sha, runId, attempt }, kind) {
  const id = /^[1-9][0-9]{0,19}$/;
  if (!matches(sha, /^[0-9a-f]{40}$/) || !matches(runId, id) || !matches(attempt, id) ||
      (kind !== 'd1' && kind !== 'worker')) throw invalid();
  return { schema, kind, sha, runId, attempt };
}

function name({ sha, runId, attempt, kind }) {
  return `drive-staging-recovery-${kind}-${sha}-run-${runId}-attempt-${attempt}`;
}

export const qualificationRecoveryKey = (source, kind) => name(scope(source, kind));

function serialize(identity, input) {
  if (identity.kind === 'd1') {
    if (!matches(input.bookmark, /^[A-Za-z0-9_-]{1,1024}$/)) throw invalid();
    return JSON.stringify({ ...identity, bookmark: input.bookmark });
  }
  const { version, expiresAt, previousVersion, previousDeployment } = input;
  if (![version, previousVersion, previousDeployment].every(value => matches(value, uuid)) ||
      version === previousVersion || !matches(expiresAt, /^[1-9][0-9]{12}$/)) throw invalid();
  return JSON.stringify({ ...identity, version, expiresAt, previousVersion, previousDeployment });
}

// Unwired. The caller supplies a private, durable create-only store and bounds
// and authenticates both operations. Read must be fresh, not a local write echo.
// The transport must limit bytes before buffering. Do not log record contents.
export function qualificationRecoveryWriter(source, { create, read } = {}) {
  if (typeof create !== 'function' || typeof read !== 'function') throw invalid();
  const { sha, runId, attempt } = scope(source, 'd1');
  const prefix = qualificationPrefix({ runId, attempt });
  return async (record, signal) => {
    try {
      signal?.throwIfAborted();
      const identity = scope({ sha, runId, attempt }, record.kind);
      if (record.sha !== sha || record.runId !== runId || record.attempt !== attempt || record.prefix !== prefix) {
        throw invalid();
      }
      const key = name(identity);
      const body = serialize(identity, record);
      // An ambiguous create must fail this attempt, not be retried or treated
      // as success based on a coincidentally matching existing record.
      if (await create(key, body, signal) !== true) throw invalid();
      signal?.throwIfAborted();
      if (await read(key, { maxBytes: maxRecordBytes, signal }) !== body) throw invalid();
      signal?.throwIfAborted();
      return true;
    } catch {
      throw invalid();
    }
  };
}

// Source identity must come from the authenticated completed workflow attempt,
// never from the storage response. The record cannot itself authorize recovery.
export async function readQualificationRecoveryRecord(source, kind, { read }, signal) {
  try {
    const identity = scope(source, kind);
    signal?.throwIfAborted();
    const body = await read(name(identity), { maxBytes: maxRecordBytes, signal });
    if (typeof body !== 'string' || Buffer.byteLength(body) > maxRecordBytes) throw invalid();
    const record = JSON.parse(body);
    // A byte comparison also rejects duplicate/unknown fields and binds the
    // storage payload to the expected kind, commit, run and attempt.
    if (serialize(identity, record) !== body) throw invalid();
    signal?.throwIfAborted();
    return record;
  } catch {
    throw invalid();
  }
}
