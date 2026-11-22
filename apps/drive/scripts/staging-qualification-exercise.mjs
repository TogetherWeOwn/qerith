import { assertQualificationJob, qualificationPrefix } from './staging-qualification.mjs';
import { exerciseQualificationAccess } from './staging-qualification-access.mjs';
import { exerciseQualificationFiles } from './staging-qualification-files.mjs';
import { exerciseQualificationLargeTransfer, exerciseQualificationResume } from './staging-qualification-app-transfer.mjs';
import { createQualificationStorageCases } from './staging-qualification-storage-cases.mjs';

const groups = {
  access: ['passkey-positive', 'passkey-negative', 'invite-acceptance', 'member-revocation', 'cross-user-denial', 'unauthenticated-file-denial'],
  files: ['authenticated-file-access', 'folder-operations', 'share-and-revoke'],
  storage: ['s3-multipart', 's3-range', 's3-retry', 's3-persistence'],
  large: ['large-transfer-hash'],
  resume: ['interrupted-transfer-resume'],
  deletion: ['delete-envelope', 'delete-boundary-and-safe-fallback', 'delete-rollback-and-retry', 'delete-provider-proof'],
};
export const qualificationExerciseCases = Object.freeze(Object.values(groups).flat());
const versionId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const unverified = phase => new Error(`Qualification exercise is unverified (${phase}).`);

function verifyCases(evidence, names) {
  if (!evidence || typeof evidence !== 'object' || Reflect.ownKeys(evidence).length !== names.length ||
      !names.every(name => Object.getOwnPropertyDescriptor(evidence, name)?.value === 'pass')) {
    throw unverified('case evidence');
  }
  return Object.freeze(Object.fromEntries(names.map(name => [name, 'pass'])));
}

// Only this composer issues evidence, and only the exact lifecycle invocation can consume it.
const issued = new WeakMap();

export function verifyQualificationExercise(evidence, context, signal) {
  const invocation = issued.get(evidence);
  if (!invocation || invocation.context !== context || invocation.signal !== signal || signal.aborted) {
    throw unverified('case evidence');
  }
  issued.delete(evidence);
  return evidence;
}

// No workflow caller. App operations must observe the candidate, use isolated
// fixtures, and drain before settling on abort. The lifecycle owns the overall
// budget and post-case cleanup (including any partly provisioned fixtures).
export async function createQualificationExercise(env, cwd, { withAccessFixtures, readFileFixtures,
  openTransferClient, openDeletion, send } = {}) {
  const settings = { ...env };
  const identity = assertQualificationJob(settings, cwd);
  const prefix = qualificationPrefix(identity);
  if ([withAccessFixtures, readFileFixtures, openTransferClient, openDeletion, send].some(fn => typeof fn !== 'function')) {
    throw unverified('adapters');
  }
  const storage = await createQualificationStorageCases(settings, cwd, { send });
  const storageScope = Object.freeze({ endpoint: new URL(settings.QERITH_S3_ENDPOINT).origin,
    bucket: settings.QERITH_S3_BUCKET, epoch: settings.QERITH_S3_STORAGE_EPOCH });
  let started = false;
  return async (context, signal) => {
    const { version } = context ?? {};
    if (started || !signal || signal.aborted || context?.prefix !== prefix ||
        Object.keys(identity).some(key => context[key] !== identity[key]) ||
        typeof version !== 'string' || !versionId.test(version)) throw unverified('scope');
    started = true;
    const active = Object.freeze({ ...identity, prefix, version });
    const results = {};
    const run = async (group, task) => {
      try {
        signal.throwIfAborted();
        const evidence = await task();
        signal.throwIfAborted();
        Object.assign(results, verifyCases(evidence, groups[group]));
      } catch {
        throw unverified(group);
      }
    };
    let revokedMemberId;
    await run('access', async () => {
      const access = await exerciseQualificationAccess(active, signal, { withFixtures: withAccessFixtures });
      revokedMemberId = access.revokedMemberId;
      return access.evidence;
    });
    await run('files', async () => exerciseQualificationFiles(active, signal, await readFileFixtures(active, signal)));
    await run('storage', () => storage(active, signal));
    await run('large', () => exerciseQualificationLargeTransfer(active, signal, openTransferClient, revokedMemberId));
    await run('resume', () => exerciseQualificationResume(active, signal, openTransferClient, revokedMemberId));
    await run('deletion', async () => {
      const { exerciseQualificationDeletion } = await import('./staging-qualification-deletion.mjs');
      signal.throwIfAborted();
      const io = await openDeletion(active, storageScope, signal);
      const reported = io?.scope;
      if (Object.keys(storageScope).some(key => reported?.[key] !== storageScope[key])) throw unverified('deletion scope');
      return exerciseQualificationDeletion(active, signal, storageScope, io);
    });
    const evidence = verifyCases(results, qualificationExerciseCases);
    issued.set(evidence, { context, signal });
    return evidence;
  };
}
