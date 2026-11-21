import type { PrivateDeletionQualification } from './private-deletion-reconciliation';
import { deletePrivateEntry } from './private-deletion-route';
import { allowsQualificationTraffic, stagingOrigin } from './qualification-readiness';
import { allowsOrigin, allowsStagingInviteSite } from './request-auth';

type StagingDeletionEnv = Parameters<typeof deletePrivateEntry>[2] & {
  DRIVE_STAGING_DELETE_REQUESTS?: string;
};

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
  if (env.DRIVE_ORIGIN !== stagingOrigin || env.DRIVE_SIGN_IN_FIXTURE === '1' ||
      !allowsQualificationTraffic(env) || env.DRIVE_STAGING_DELETE_REQUESTS !== '1' || !qualification) return denied(404);
  if (!allowsOrigin(request, stagingOrigin) || !allowsStagingInviteSite(request)) return denied(403);
  return deletePrivateEntry(request, entryId, env, qualification);
}
