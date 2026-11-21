import { error } from '@sveltejs/kit';
import { env } from 'cloudflare:workers';
import { createSharedReadAccess } from '../../lib/server/metadata/read-access';
import { sharedPageCursor, validSharedCursor } from '../../lib/server/shared-page';
import type { PageServerLoad } from './$types';

export const csr = false;

export const load: PageServerLoad = async ({ locals, url, setHeaders }) => {
  setHeaders({ 'referrer-policy': 'no-referrer' });
  const session = locals.driveSession;
  if (session?.principal.role !== 'member') error(404, 'Not found');
  const cursor = sharedPageCursor(url.search);
  if (cursor === undefined) error(400, 'Invalid page request');
  const db = env.DB;
  if (typeof db?.withSession !== 'function') error(503, 'Shared items are unavailable.');
  const page = await createSharedReadAccess(db).listShared(session.token, cursor).catch(() => {
    error(503, 'Shared items are unavailable.');
  });
  if (page.nextCursor !== null && !validSharedCursor(page.nextCursor)) error(503, 'Shared items are unavailable.');
  return {
    entries: page.entries.map(({ id, name, kind }) => ({ id, name, kind })),
    nextCursor: page.nextCursor,
    continued: cursor !== null,
  };
};
