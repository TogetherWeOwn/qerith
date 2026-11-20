import { env } from 'cloudflare:workers';
import { folderPage } from '../../../lib/server/folder-page';
import { ReadAccess } from '../../../lib/server/metadata/read-access';
import type { PageServerLoad } from './$types';

export const csr = false;

export const load: PageServerLoad = async ({ request, params, locals, setHeaders }) => {
  setHeaders({ 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' });
  const db = env.DB;
  if (!locals.driveSession || typeof db?.withSession !== 'function') return { result: { status: 'unavailable' as const } };
  // Each ReadAccess statement rechecks the session on the primary.
  const primary = () => new ReadAccess(db.withSession('first-primary'));
  return { result: await folderPage(request, params.folderId, {
    authorize: async () => locals.driveSession?.token ?? null,
    readAccess: {
      get: (...args) => primary().get(...args),
      list: (...args) => primary().list(...args),
    },
  }) };
};
