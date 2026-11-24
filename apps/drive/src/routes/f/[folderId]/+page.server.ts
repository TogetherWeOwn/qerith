import { building } from '$app/env';
import { env } from 'cloudflare:workers';
import { folderPage } from '../../../lib/server/folder-page';
import { ReadAccess } from '../../../lib/server/metadata/read-access';
import { admitsSignInFixture, admitsStagingInvite, admitsStagingReadGrants } from '../../../lib/server/request-auth';
import { requestStorageIdentity } from '../../../lib/server/storage-runtime';
import type { PageServerLoad } from './$types';

export const csr = !building && admitsStagingInvite(env);

export const load: PageServerLoad = async ({ request, params, locals, setHeaders }) => {
  setHeaders({ 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' });
  const db = env.DB, session = locals.driveSession, inviteMode = admitsStagingInvite(env);
  if (!(admitsSignInFixture(env) || inviteMode) || !session || typeof db?.withSession !== 'function') {
    return { result: { status: 'unavailable' as const } };
  }
  // Each ReadAccess statement rechecks the session on the primary.
  const identity = await requestStorageIdentity(env);
  const primary = () => new ReadAccess(db.withSession('first-primary'),
    identity ? [identity.settings.endpoint, identity.settings.bucket, identity.epoch] : undefined);
  const { id, role } = session.principal;
  const result = await folderPage(request, params.folderId, {
    authorize: async () => session.token,
    metadataWriteAllowed: inviteMode && (role === 'owner' || role === 'member'),
    shareAllowed: inviteMode && admitsStagingReadGrants(env),
    readAccess: { get: (...args) => primary().get(...args), list: (...args) => primary().list(...args) },
  });
  return { result, ownerInvites: role === 'owner' && inviteMode,
    shareOwner: result.status === 'ok' && result.folder.entries.some(entry => entry.shareable)
    ? { recipientId: id, driveOwner: role === 'owner' } : undefined };
};
