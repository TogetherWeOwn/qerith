import { createAuthorizedPrivateDeletion } from './metadata/private-deletion';
import { bindPrivateDeletionStorage, type PrivateDeletionQualification } from './private-deletion-reconciliation';
import { admitsStagingInvite, allowsOrigin, authOrigin, readSession, stagingOrigin, type DriveAuthEnv } from './request-auth';
import type { StorageBindings } from './storage-runtime';
import { readUploadBody, uploadIdPattern } from './upload-part';

type Database = Parameters<typeof createAuthorizedPrivateDeletion>[0] & Parameters<typeof bindPrivateDeletionStorage>[0];
type DeletionEnv = DriveAuthEnv & StorageBindings & { DB?: Database };

const reply = (status: number) => new Response(null, { status, headers: { 'cache-control': 'private, no-store' } });

// One canonical confirmation avoids contradictory duplicate JSON fields.
const confirmation = '{"confirm":"permanent-delete"}';
async function confirmed(request: Request): Promise<boolean> {
  if (request.headers.get('content-type') !== 'application/json' ||
      request.headers.get('content-length') !== String(confirmation.length)) return false;
  const bytes = await readUploadBody(request, confirmation.length).catch(() => null);
  return bytes !== null && new TextDecoder().decode(bytes) === confirmation;
}

// The generated Worker supplies no qualification. Staging admission is separate.
export async function deletePrivateEntry(request: Request, entryId: string, env: DeletionEnv,
  qualification?: PrivateDeletionQualification): Promise<Response> {
  if (request.method !== 'POST') {
    const response = reply(405);
    response.headers.set('allow', 'POST');
    return response;
  }
  const origin = authOrigin(env.DRIVE_ORIGIN);
  const db = env.DB;
  if (!origin || !db) return reply(503);
  if (!allowsOrigin(request, origin.origin)) return reply(403);

  try {
    const session = await readSession(request, db);
    if (!session) return reply(401);
    if (!qualification) return reply(404);
    if (origin.origin === stagingOrigin && session.principal.role === 'member' && !admitsStagingInvite(env)) return reply(403);
    if (!uploadIdPattern.test(entryId) || !await confirmed(request)) return reply(400);
    const binding = bindPrivateDeletionStorage(db, env, qualification);
    if (!binding) return reply(503);
    const { settings, epoch, reconcile } = binding;
    const committed = await createAuthorizedPrivateDeletion(db, epoch, settings).delete(session.token, entryId);
    if (!committed) return reply(404);
    // One bounded, journal-scoped pass. Acceptance never certifies provider removal.
    await reconcile(committed.deletionId).catch(() => {});
    return reply(202);
  } catch { return reply(503); }
}
