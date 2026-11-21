import { assertQualificationJob, qualificationPrefix } from './staging-qualification.mjs';
import { applyQualificationMigrations } from './staging-qualification-migrations.mjs';
import { verifyQualificationExercise } from './staging-qualification-exercise.mjs';
import {
  probeQualificationWorker, runQualificationPhase, uploadQualificationWorker, withQualificationRecovery, withQualificationWorker,
} from './staging-qualification-worker.mjs';

const stagingAdapters = Object.freeze({
  upload: uploadQualificationWorker,
  migrate: applyQualificationMigrations,
  worker: withQualificationWorker,
  probe: probeQualificationWorker,
});

// No workflow caller yet. The caller must hold the shared staging lock, build
// the exact SHA, and supply reviewed, abortable operations that drain on abort.
export async function runQualificationLifecycle({ assertFullV0, recordRecovery, inventory, exercise, cleanup },
  env, cwd, signal, { upload, migrate, worker, probe } = stagingAdapters) {
  const identity = assertQualificationJob(env, cwd);
  if ([assertFullV0, recordRecovery, inventory, exercise, cleanup].some(fn => typeof fn !== 'function')) {
    throw new Error('Qualification lifecycle requires full-v0 checks, recovery, inventory and cleanup.');
  }
  const context = { ...identity, prefix: qualificationPrefix(identity) };
  const requireProof = async (task, input, parentSignal, timeout, message) => {
    if (await runQualificationPhase(task, input, parentSignal, timeout) !== true) throw new Error(message);
  };
  const inspect = (phase, parentSignal) => requireProof(inventory, { ...context, phase }, parentSignal, 60_000,
    `Staging zero-idle inventory is unverified (${phase}).`);
  const record = kind => evidence => requireProof(recordRecovery, { ...evidence, ...context, kind }, signal, 15_000,
    'Qualification recovery record is unverified.');

  // No staging mutation before reviewed admission and inventory checks.
  await requireProof(assertFullV0, context, signal, 30_000, 'Reviewed full-v0 admission is unverified.');
  await inspect('before', signal);
  const result = await withQualificationRecovery(async () => {
    signal?.throwIfAborted();
    // Reject a stale upload-history baseline before any D1 changes. Do not
    // force inheritance or automatically republish a baseline to make it eligible.
    const candidate = await upload(env, cwd, signal);
    signal?.throwIfAborted();
    const migrations = await migrate({ recordRecovery: record('d1') }, env, cwd, signal);
    signal?.throwIfAborted();
    const deployment = await worker({
      upload: candidate,
      recordRecovery: record('worker'),
      probe,
      exercise: async (active, phaseSignal) => {
        const invocation = Object.freeze({ ...context, version: active.version });
        return verifyQualificationExercise(await exercise(invocation, phaseSignal), invocation, phaseSignal);
      },
      cleanup: (active, phaseSignal) => cleanup({ ...active, ...context }, phaseSignal),
    }, env, cwd, signal);
    return { migrations, deployment };
  }, () => inspect('after'));
  signal?.throwIfAborted();
  return result;
}
