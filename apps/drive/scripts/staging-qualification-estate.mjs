import { assertQualificationJob, qualificationPrefix } from './staging-qualification.mjs';
import { createQualificationR2Cleanup } from './staging-qualification-cleanup.mjs';
import { cleanQualificationD1 } from './staging-qualification-d1.mjs';
import { createQualificationInventory } from './staging-qualification-inventory.mjs';
import { verifyQualificationQuiescence } from './staging-qualification-quiescence.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';

const unverified = () => new Error('Qualification estate cleanup is unverified.');

// No protected workflow caller. The holder must keep the exclusive writer fence
// through cleanup readback, and abort its signal on loss; a snapshot alone is insufficient.
export function createQualificationEstate(env, cwd, { readWriterFence, ...reads } = {}) {
  if (typeof readWriterFence !== 'function') throw unverified();
  env = { ...env };
  const identity = assertQualificationJob(env, cwd);
  const prefix = qualificationPrefix(identity);
  const inventory = createQualificationInventory(env, cwd, reads);

  async function cleanup(context, signal) {
    if (context?.prefix !== prefix || Object.keys(identity).some(key => context[key] !== identity[key])) throw unverified();
    const { version, expiresAt } = context;
    const source = Object.freeze({ ...identity, version, expiresAt });
    signal.throwIfAborted();
    const { snapshot, signal: fenceSignal } = await readWriterFence(source, signal) ?? {};
    if (!(fenceSignal instanceof AbortSignal)) throw unverified();
    const held = AbortSignal.any([signal, fenceSignal]);
    const { validUntil } = verifyQualificationQuiescence(source, snapshot, { now: Date.now, signal: held });
    const remaining = validUntil - Date.now();
    if (remaining <= 0) throw unverified();
    await runQualificationPhase(async (_, active) => {
      const assertHeld = () => {
        active.throwIfAborted();
        if (Date.now() >= validUntil) throw unverified();
      };
      const send = request => { assertHeld(); return reads.send(request); };
      const cleanR2 = await createQualificationR2Cleanup(env, cwd, { send });
      const request = (...args) => { assertHeld(); return reads.request(...args); };
      const scope = { ...source, prefix };
      // Disjoint stores; share the deadline, but drain both before Worker restore.
      const results = await Promise.allSettled([
        cleanR2(scope, active), cleanQualificationD1(scope, env, cwd, active, request),
      ]);
      assertHeld();
      if (results.some(result => result.status !== 'fulfilled' || result.value !== true)) throw unverified();
    }, null, held, Math.min(remaining, 60_000));
    return true;
  }
  return { inventory, cleanup };
}
