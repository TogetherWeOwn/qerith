import { assertQualificationJob, qualificationPrefix } from './staging-qualification.mjs';
import { createQualificationEstate } from './staging-qualification-estate.mjs';
import { createQualificationExercise, verifyQualificationExercise } from './staging-qualification-exercise.mjs';
import { applyQualificationMigrations } from './staging-qualification-migrations.mjs';
import { createQualificationR2RecoveryStore } from './staging-qualification-recovery-r2.mjs';
import { qualificationRecoveryWriter } from './staging-qualification-recovery-record.mjs';
import { assertQualificationSettings } from './staging-qualification-settings.mjs';
import {
  probeQualificationWorker, qualificationMigrationTimeLeft, runQualificationPhase, uploadQualificationWorker,
  withQualificationRecovery, withQualificationWorker,
} from './staging-qualification-worker.mjs';

const recordBudget = 15_000;
const insufficientWindow = () => new Error('Staging candidate has insufficient time left for migrations and activation.');

const stagingAdapters = (send = fetch) => ({
  upload: (env, cwd, signal) => uploadQualificationWorker(env, cwd, signal, send),
  migrate: applyQualificationMigrations,
  worker: (ops, env, cwd, signal) => withQualificationWorker(ops, env, cwd, signal, send),
  probe: (context, signal) => probeQualificationWorker(context, signal, send),
});

// Offline composition only. No provider I/O during construction. A protected
// caller must hold the lifecycle lock and supply real admission, estate,
// app case and writer-fence adapters. `stageOverrides` is an offline test seam.
export async function createQualificationLifecycle(env, cwd, { assertFullV0, readWriterFence, readEstate,
  withAccessFixtures, readFileFixtures, openTransferClient, openDeletion, send } = {}, stageOverrides) {
  if (typeof assertFullV0 !== 'function' || typeof send !== 'function') {
    throw new Error('Qualification lifecycle requires reviewed admission and an explicit transport.');
  }
  const settings = Object.freeze({ ...env });
  const source = assertQualificationJob(settings, cwd);
  await assertQualificationSettings(settings, cwd);
  const estate = createQualificationEstate(settings, cwd, { readWriterFence, readEstate, request: send, send });
  const exercise = await createQualificationExercise(settings, cwd, {
    withAccessFixtures, readFileFixtures, openTransferClient, openDeletion, send,
  });
  const store = await createQualificationR2RecoveryStore(source, settings, cwd, { send });
  const recordRecovery = qualificationRecoveryWriter(source, store);
  const stages = { ...stagingAdapters(send), ...stageOverrides };
  let started = false;
  return async signal => {
    if (started) throw new Error('Qualification lifecycle already started.');
    started = true;
    return runQualificationLifecycle({ ...estate, assertFullV0, exercise, recordRecovery }, settings, cwd, signal, {
      ...stages,
      async upload(env, cwd, signal) {
        // A stranded, undeployed upload would make the next baseline ineligible.
        // Check retention before uploading, without replacing the per-write checks.
        await store.assertRetention(signal);
        signal?.throwIfAborted();
        return stages.upload(env, cwd, signal);
      },
    });
  };
}

// No workflow caller yet. The caller must hold the shared staging lock, build
// the exact SHA, and supply reviewed, abortable operations that drain on abort.
export async function runQualificationLifecycle({ assertFullV0, recordRecovery, inventory, exercise, cleanup },
  env, cwd, signal, { upload, migrate, worker, probe } = stagingAdapters()) {
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
  const record = (kind, parentSignal = signal) => evidence => requireProof(recordRecovery,
    { ...evidence, ...context, kind }, parentSignal, recordBudget, 'Qualification recovery record is unverified.');

  // No staging mutation before reviewed admission and inventory checks.
  await requireProof(assertFullV0, context, signal, 30_000, 'Reviewed full-v0 admission is unverified.');
  await inspect('before', signal);
  const result = await withQualificationRecovery(async () => {
    signal?.throwIfAborted();
    // Reject a stale upload-history baseline before any D1 changes. Do not
    // force inheritance or automatically republish a baseline to make it eligible.
    const candidate = await upload(env, cwd, signal);
    signal?.throwIfAborted();
    const { expiresAt } = candidate ?? {};
    const started = performance.now();
    const remaining = () => qualificationMigrationTimeLeft(expiresAt, recordBudget);
    const budget = remaining();
    if (budget <= 0) throw insufficientWindow();
    const timeLeft = () => Math.min(remaining(), started + budget - performance.now());
    const migrations = await runQualificationPhase((_, active) => migrate({
      timeLeft, recordRecovery: record('d1', active),
    }, env, cwd, active), null, signal, budget, remaining);
    if (timeLeft() <= 0) throw insufficientWindow();
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
