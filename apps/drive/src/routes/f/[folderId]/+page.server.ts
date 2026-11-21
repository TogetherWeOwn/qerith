import { env } from 'cloudflare:workers';
import { folderPage } from '../../../lib/server/folder-page';
import { ReadAccess } from '../../../lib/server/metadata/read-access';
import { admitsSignInFixture, admitsStagingInvite } from '../../../lib/server/request-auth';
import { storageIdentity } from '../../../lib/server/storage-runtime';
import type { PageServerLoad } from './$types';

export const csr = false;

export const load: PageServerLoad = async ({ request, params, locals, setHeaders }) => {
  setHeaders({ 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' });
  const db = env.DB;
  if (!(admitsSignInFixture(env) || admitsStagingInvite(env)) || !locals.driveSession || typeof db?.withSession !== 'function') {
    return { result: { status: 'unavailable' as const } };
  }
  // Each ReadAccess statement rechecks the session on the primary.
  const identity = storageIdentity(env);
  const primary = () => new ReadAccess(db.withSession('first-primary'),
    identity ? [identity.settings.endpoint, identity.settings.bucket, identity.epoch] : undefined);
  return { result: await folderPage(request, params.folderId, {
    authorize: async () => locals.driveSession?.token ?? null,
    readAccess: { get: (...args) => primary().get(...args), list: (...args) => primary().list(...args) },
  }) };
};
