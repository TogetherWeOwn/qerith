import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { createSharedReadAccess } from '../../lib/server/metadata/read-access';
import { sharedPageCursor, validSharedCursor } from '../../lib/server/shared-page';
import { storageIdentity } from '../../lib/server/storage-runtime';
import type { PageServerLoad } from './$types';

export const csr = false;

export const load: PageServerLoad = async ({ locals, url, setHeaders }) => {
  setHeaders({ 'referrer-policy': 'no-referrer' });
  const session = locals.driveSession;
  if (session?.principal.role !== 'member') error(404, 'Not found');
  const cursor = sharedPageCursor(url.search);
  if (cursor === undefined) error(400, 'Invalid page request');
  const unavailable = (retryCursor: string | null) => ({ status: 'unavailable' as const, retryCursor });
  const db = env.DB;
  if (typeof db?.withSession !== 'function') return unavailable(cursor);
  const identity = storageIdentity(env);
  const access = createSharedReadAccess(db, identity ? [identity.settings.endpoint, identity.settings.bucket, identity.epoch] : undefined);
  const page = await access.listShared(session.token, cursor).catch(() => null);
  if (!page) return unavailable(cursor);
  if (page.nextCursor !== null && !validSharedCursor(page.nextCursor)) return unavailable(null);
  return {
    status: 'ok' as const,
    entries: page.entries.map(({ id, name, kind, downloadable }) => ({ id, name, kind, downloadable: downloadable === 1 })),
    nextCursor: page.nextCursor,
    continued: cursor !== null,
  };
};
