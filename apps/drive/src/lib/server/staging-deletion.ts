import { bindPrivateDeletionStorage, type PrivateDeletionQualification } from './private-deletion-reconciliation';
import { deletePrivateEntry } from './private-deletion-route';
import { allowsQualificationTraffic, stagingOrigin, type QualificationReadinessEnv } from './qualification-readiness';
import { allowsOrigin, allowsStagingInviteSite } from './request-auth';
import { storageIdentity } from './storage-runtime';

type StagingDeletionEnv = Parameters<typeof deletePrivateEntry>[2] & QualificationReadinessEnv & {
  DRIVE_STAGING_DELETE_REQUESTS?: string;
  DRIVE_STAGING_DELETE_DRAIN?: string;
};

function isStagingDeletionRuntime(env: QualificationReadinessEnv): boolean {
  return env.DRIVE_ORIGIN === stagingOrigin && env.DRIVE_SIGN_IN_FIXTURE !== '1' && allowsQualificationTraffic(env);
}

/** Held by the Worker composer, independently of the active runtime bindings. */
export type WorkerDeletionCapability = PrivateDeletionQualification & Readonly<{
  sourceSha: string;
  workerVersion: string;
  expiresAt: string;
}>;

export function resolveWorkerDeletionQualification(env: StagingDeletionEnv,
  capability?: WorkerDeletionCapability): PrivateDeletionQualification | undefined {
  if (!capability || env.DRIVE_QUALIFICATION_SHA === undefined || !isStagingDeletionRuntime(env) ||
      capability.sourceSha !== env.DRIVE_QUALIFICATION_SHA ||
      capability.workerVersion !== env.DRIVE_QUALIFICATION_VERSION?.id ||
      capability.expiresAt !== env.DRIVE_QUALIFICATION_EXPIRES_AT ||
      typeof capability.confirmsRemoval !== 'function') return;
  const identity = storageIdentity(env);
  if (identity && capability.storageConfigId === identity.storageConfigId &&
      capability.region === identity.settings.region) return capability;
}

const denied = (status: number) => Promise.resolve(new Response(null, {
  status, headers: { 'cache-control': 'private, no-store' }
}));

/** Exact staging route; qualification is supplied by trusted Worker code only. */
export function dispatchStagingDeletion(request: Request, env: StagingDeletionEnv,
  qualification?: PrivateDeletionQualification): Promise<Response> | undefined {
  const { pathname } = new URL(request.url);
  const entryId = /^\/api\/entries\/([^/%]+)\/delete$/.exec(pathname)?.[1];
  // Reject URL aliases here; the qualified handler owns method and ID validation.
  if (!entryId || request.url !== stagingOrigin + pathname) return;
  if (!isStagingDeletionRuntime(env) || env.DRIVE_STAGING_DELETE_REQUESTS !== '1' || !qualification) return denied(404);
  if (!allowsOrigin(request, stagingOrigin) || !allowsStagingInviteSite(request)) return denied(403);
  return deletePrivateEntry(request, entryId, env, qualification);
}

export const deletionDrainCron = '*/15 * * * *';

/** Called only by the Worker's scheduled event, independently of HTTP admission. */
export async function runStagingDeletionDrain(event: { cron: string }, env: StagingDeletionEnv,
  qualification?: PrivateDeletionQualification): Promise<number> {
  if (event.cron !== deletionDrainCron || !isStagingDeletionRuntime(env) ||
      env.DRIVE_STAGING_DELETE_DRAIN !== '1' || !qualification) return 0;
  const db = env.DB;
  const binding = db && bindPrivateDeletionStorage(db, env, qualification);
  return binding ? binding.drain() : 0;
}
