import { qualificationPrefix } from './staging-qualification.mjs';
import { verifyQualificationQuiescence } from './staging-qualification-quiescence.mjs';
import { createQualificationR2RecoveryStore } from './staging-qualification-recovery-r2.mjs';
import { readQualificationRecoveryRecord } from './staging-qualification-recovery-record.mjs';
import { createQualificationRecoverySource } from './staging-qualification-recovery-source.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';

const repo = 'TogetherWeOwn/qerith';
const workflow = '.github/workflows/drive-staging-qualification.yml';
const id = /^[1-9][0-9]{0,19}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const sameAttempt = (value, { sha, runId, attempt }) =>
  value?.sha === sha && value.runId === runId && value.attempt === attempt;
const refused = phase => new Error(`Staging qualification recovery is unverified (${phase}).`);

// Unwired. The protected caller holds the shared lifecycle lock throughout.
// readSource authenticates the exact workflow attempt and its source job from
// GitHub, and reads the current attempt separately. A successful source job
// proves tested SHA = dispatch SHA = checkout and main ancestry for that attempt.
// readRecord returns authenticated, validated records, not bare store objects.
// readWriterFence returns authoritative observations and the holder's loss
// signal, not the signal of the phase that reads the observations. Keep the
// fence held through final readback. Mutation adapters must check assertHeld
// at I/O boundaries and drain on abort. D1 and R2 return true only after verification.
export async function recoverQualification(request, { readSource, readRecord, readWriterFence, recoverWorker,
  recoverD1, cleanupR2 } = {}, signal) {
  const { sha, runId, attempt } = request ?? {};
  if (!matches(sha, /^[0-9a-f]{40}$/) || !matches(runId, id) || !matches(attempt, id) ||
      [readSource, readRecord, readWriterFence, recoverWorker, recoverD1, cleanupR2].some(fn => typeof fn !== 'function')) {
    throw refused('input');
  }
  const source = Object.freeze({ sha, runId, attempt });
  const prefix = qualificationPrefix(source);
  const phase = async (name, timeout, task, fence) => {
    try {
      const parent = fence ? AbortSignal.any([signal, fence.signal].filter(Boolean)) : signal;
      const budget = fence ? Math.min(timeout, fence.validUntil - Date.now()) : timeout;
      if (budget <= 0) throw refused(name);
      return await runQualificationPhase(async (_, active) => {
        const assertHeld = () => {
          active.throwIfAborted();
          if (fence && Date.now() >= fence.validUntil) throw refused(name);
        };
        assertHeld();
        const value = await task(active, assertHeld);
        assertHeld();
        return value;
      }, null, parent, budget);
    } catch {
      // Never propagate provider diagnostics, record contents or abort reasons.
      throw refused(name);
    }
  };
  const evidence = await phase('source', 15_000, active => readSource(source, active));
  if (!sameAttempt(evidence, source) || evidence.repository !== repo || evidence.headRepository !== repo ||
      evidence.workflow !== workflow || evidence.ref !== 'refs/heads/main' || evidence.event !== 'workflow_dispatch' ||
      evidence.status !== 'completed' || !['failure', 'cancelled', 'timed_out'].includes(evidence.conclusion) ||
      evidence.sourceJobConclusion !== 'success' || evidence.latestAttempt !== attempt) throw refused('source');

  // Missing records are not proof that a mutation never started. Do not do a
  // partial recovery when either record is absent, malformed or from another attempt.
  const record = (kind, valid) => phase(`${kind} record`, 15_000, async active => {
    const value = { ...await readRecord(source, kind, active) };
    if (!sameAttempt(value, source) || value.kind !== kind || !valid(value)) throw refused(`${kind} record`);
    return Object.freeze(value);
  });
  const d1 = await record('d1', value => matches(value.bookmark, /^[A-Za-z0-9_-]{1,1024}$/));
  const worker = await record('worker', ({ version, previousVersion, previousDeployment, expiresAt }) =>
    [version, previousVersion, previousDeployment].every(value => matches(value, uuid)) &&
    version !== previousVersion && matches(expiresAt, /^[1-9][0-9]{12}$/));
  const context = Object.freeze({ ...source, prefix });
  const fence = await phase('writer quiescence', 30_000, async active => {
    const { version, expiresAt } = worker;
    const candidate = Object.freeze({ ...source, version, expiresAt });
    const { snapshot, signal: held } = await readWriterFence(candidate, active) ?? {};
    if (!(held instanceof AbortSignal) || held === active) throw refused('writer quiescence');
    const { validUntil } = verifyQualificationQuiescence(candidate, snapshot, { now: Date.now, signal: held });
    return { signal: held, validUntil };
  });
  const requireProof = async (name, timeout, task) => {
    if (await phase(name, timeout, task, fence) !== true) throw refused(name);
  };

  const restored = await phase('Worker restore', 45_000,
    (active, assertHeld) => recoverWorker(source, worker, active, assertHeld), fence);
  // Baseline observation is acceptable only AFTER independent writer proof.
  if (restored?.version !== worker.previousVersion ||
      !(restored.status === 'baseline-observed' && restored.deployment === worker.previousDeployment ||
        restored.status === 'restored' && matches(restored.deployment, uuid) &&
          restored.deployment !== worker.previousDeployment)) throw refused('Worker restore');
  await requireProof('D1 recovery', 120_000, (active, assertHeld) => recoverD1(source, d1, active, assertHeld));
  await requireProof('R2 cleanup', 60_000, (active, assertHeld) => cleanupR2(context, active, assertHeld));
  if (signal?.aborted || fence.signal.aborted || Date.now() >= fence.validUntil) throw refused('R2 cleanup');
}

// Offline composition only. No transport, writer fence or mutation adapter defaults.
export function createQualificationRecovery(env, cwd, { token, githubRequest, send,
  readWriterFence, recoverWorker, recoverD1, cleanupR2 } = {}) {
  if (typeof send !== 'function') throw refused('input');
  env = { ...env };
  const readSource = createQualificationRecoverySource({ token, request: githubRequest });
  return (request, signal) => recoverQualification(request, {
    readSource, readWriterFence, recoverWorker, recoverD1, cleanupR2,
    async readRecord(source, kind, active) {
      const store = await createQualificationR2RecoveryStore(source, env, cwd, { send });
      return readQualificationRecoveryRecord(source, kind, store, active);
    },
  }, signal);
}
