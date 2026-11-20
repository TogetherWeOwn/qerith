import { InvalidFolderPage, ReadAccess, createSharedReadAccess, type FolderPage, type SharedReadPage } from './metadata/read-access';
import { admitsSignInFixture, allowsOrigin, readSession, type DriveAuthEnv } from './request-auth';

type ListingEnv = DriveAuthEnv & { DB?: { withSession(constraint: 'first-primary'): NonNullable<DriveAuthEnv['DB']> } };
const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers: status === 405 ? { ...headers, allow: 'GET' } : headers });
const encoder = new TextEncoder();
// Shared cursors are stored IDs bound verbatim, not necessarily UUIDs.
const validId = (id: string) => id.length > 0 && encoder.encode(id).length <= 512;
const project = (page: SharedReadPage): SharedReadPage => ({
  entries: page.entries.map(({ id, name, kind }) => ({ id, name, kind })), nextCursor: page.nextCursor,
});

// Only the disposable sign-in fixture can reach these paths. Do not add them to
// staging admission; handle them before ordinary app auth and redirects.
export function listingRequest(request: Request, env: ListingEnv): Promise<Response> | undefined {
  const url = new URL(request.url);
  const folder = url.pathname === '/api/folder-listing';
  if (!folder && url.pathname !== '/api/shared-listing') return;
  return listPage(request, url, env, folder);
}

async function listPage(request: Request, url: URL, env: ListingEnv, folder: boolean): Promise<Response> {
  if (!admitsSignInFixture(env)) return reply(404);
  if (request.method !== 'GET') return reply(405);
  const site = request.headers.get('sec-fetch-site');
  if (!allowsOrigin(request, env.DRIVE_ORIGIN ?? '') || (site !== null && site !== 'same-origin')) return reply(403);
  if (url.search.length > 8192) return reply(400);
  // URLSearchParams silently repairs malformed percent escapes and UTF-8.
  try {
    decodeURIComponent(url.search);
  } catch {
    return reply(400);
  }
  const params = url.searchParams;
  const allowed = folder ? ['folderId', 'cursor', 'direction'] : ['cursor'];
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) return reply(400);
  const id = params.get('folderId') ?? '';
  const cursor = params.get('cursor');
  const direction = params.get('direction') ?? 'asc';
  if ((folder && !validId(id)) || (direction !== 'asc' && direction !== 'desc')) return reply(400);
  if (cursor !== null && !(folder ? /^[A-Za-z0-9_-]{1,2048}$/.test(cursor) : validId(cursor))) return reply(400);

  const db = env.DB;
  if (typeof db?.withSession !== 'function') return reply(503);
  try {
    const session = await readSession(request, db.withSession('first-primary'));
    if (!session) return reply(401);
    // first-primary pins only the first statement, so each page needs a fresh session.
    if (folder) {
      const page = await new ReadAccess(db.withSession('first-primary')).listPage(session.token, id, cursor, direction);
      if (!page) return reply(404);
      const body: FolderPage = { ...project(page), total: page.total, order: page.order, direction: page.direction };
      return Response.json(body, { headers });
    }
    const page = await createSharedReadAccess(db).listShared(session.token, cursor);
    if (page.nextCursor !== null && !validId(page.nextCursor)) return reply(503);
    return Response.json(project(page), { headers });
  } catch (error) {
    return reply(error instanceof InvalidFolderPage ? 400 : 503);
  }
}
