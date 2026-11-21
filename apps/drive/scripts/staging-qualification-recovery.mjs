import { qualificationPrefix } from './staging-qualification.mjs';
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
// proveWriters must exclude superseding state, new writers, in-flight writes,
// issued upload URLs and pending provider operations (including late Worker
// activation). Its proof must remain valid under the lock through all phases.
// recoverWorker binds recoverQualificationWorker's env/cwd; do not normalize
// an exception to a result. The guard, D1 and R2 return true only after verification.
// Every adapter must bound its I/O and stop and drain before settling on abort.
export async function recoverQualification(request, { readSource, readRecord, proveWriters, recoverWorker,
  recoverD1, cleanupR2 } = {}, signal) {
  const { sha, runId, attempt } = request ?? {};
  if (!matches(sha, /^[0-9a-f]{40}$/) || !matches(runId, id) || !matches(attempt, id) ||
      [readSource, readRecord, proveWriters, recoverWorker, recoverD1, cleanupR2].some(fn => typeof fn !== 'function')) {
    throw refused('input');
  }
  const source = Object.freeze({ sha, runId, attempt });
  const prefix = qualificationPrefix(source);
  const phase = async (name, timeout, task) => {
    try {
      return await runQualificationPhase((_, active) => task(active), null, signal, timeout);
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
  const requireProof = async (name, timeout, task) => {
    if (await phase(name, timeout, task) !== true) throw refused(name);
  };

  await requireProof('writer quiescence', 30_000, active => proveWriters(context, { d1, worker }, active));
  const restored = await phase('Worker restore', 45_000, active => recoverWorker(source, worker, active));
  // Baseline observation is acceptable only AFTER independent writer proof.
  if (restored?.version !== worker.previousVersion ||
      !(restored.status === 'baseline-observed' && restored.deployment === worker.previousDeployment ||
        restored.status === 'restored' && matches(restored.deployment, uuid) &&
          restored.deployment !== worker.previousDeployment)) throw refused('Worker restore');
  await requireProof('D1 recovery', 120_000, active => recoverD1(source, d1, active));
  await requireProof('R2 cleanup', 60_000, active => cleanupR2(context, active));
  if (signal?.aborted) throw refused('R2 cleanup');
}
