import { createAuthorizedPrivateDeletion } from './metadata/private-deletion';
import { createPrivateDeletionReconciler } from './private-deletion-reconciliation';
import { allowsOrigin, authOrigin, readSession, type DriveAuthEnv } from './request-auth';
import type { S3Config } from './s3/config';
import { readUploadBody, uploadIdPattern } from './upload-part';

type Database = Parameters<typeof createAuthorizedPrivateDeletion>[0] & Parameters<typeof createPrivateDeletionReconciler>[0];
type DeletionEnv = DriveAuthEnv & { DB?: Database };
type Fixture = Readonly<{
  config: S3Config;
  epoch: string;
  provider: NonNullable<Parameters<typeof createPrivateDeletionReconciler>[3]>;
}>;

// Only the in-process smoke wrapper attaches a capability to its own Request.
// The generated Worker has no binding, cookie or header that can populate this map.
export const privateDeletionFixtures = new WeakMap<Request, Fixture>();

const reply = (status: number) => new Response(null, { status, headers: { 'cache-control': 'private, no-store' } });

// One canonical confirmation avoids contradictory duplicate JSON fields.
const confirmation = '{"confirm":"permanent-delete"}';
async function confirmed(request: Request): Promise<boolean> {
  if (request.headers.get('content-type') !== 'application/json' ||
      request.headers.get('content-length') !== String(confirmation.length)) return false;
  const bytes = await readUploadBody(request, confirmation.length).catch(() => null);
  return bytes !== null && new TextDecoder().decode(bytes) === confirmation;
}

export async function deletePrivateEntry(request: Request, entryId: string, env: DeletionEnv): Promise<Response> {
  const fixture = privateDeletionFixtures.get(request);
  privateDeletionFixtures.delete(request);
  if (request.method !== 'POST') return reply(405);
  const origin = authOrigin(env.DRIVE_ORIGIN);
  const db = env.DB;
  if (!origin || !db) return reply(503);
  if (!allowsOrigin(request, origin.origin)) return reply(403);

  try {
    const session = await readSession(request, db);
    if (!session) return reply(401);
    if (!fixture) return reply(404);
    if (!uploadIdPattern.test(entryId) || !await confirmed(request)) return reply(400);
    const { config, epoch, provider } = fixture;
    const reconcile = createPrivateDeletionReconciler(db, config, epoch, provider);
    if (!reconcile) return reply(503);
    const committed = await createAuthorizedPrivateDeletion(db, epoch, config).delete(session.token, entryId);
    if (!committed) return reply(404);
    // Acceptance acknowledges the journal only, never permanent provider removal.
    await reconcile(committed.deletionId).catch(() => {});
    return reply(202);
  } catch { return reply(503); }
}
