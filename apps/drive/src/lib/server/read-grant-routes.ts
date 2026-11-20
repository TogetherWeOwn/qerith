import { ReadGrants } from './metadata/read-grants';
import { admitsSignInFixture, allowsOrigin, allowsStagingInviteSite, readSession, type DriveAuthEnv } from './request-auth';

type GrantEnv = DriveAuthEnv & { DB?: ConstructorParameters<typeof ReadGrants>[0] };
const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers });
const path = /^\/api\/entries\/([^/]{1,1536})\/read-grants(?:\/([^/]{1,1536}))?$/;
const encoder = new TextEncoder();
const validId = (id: string) => id.length > 0 && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(id) && encoder.encode(id).length <= 512;

// An ID is data, not a pathname or a UUID. Accept one canonical wire spelling.
function decodeId(wire: string): string | null {
  if (wire.length > 1536) return null;
  try {
    const id = decodeURIComponent(wire);
    return validId(id) && encodeURIComponent(id).replaceAll("'", '%27') === wire ? id : null;
  } catch { return null; }
}

// Imported by the disposable Worker wrapper only. Neither deployable admission
// layer dispatches these paths, even with the sign-in fixture binding set.
export function readGrantRequest(request: Request, env: GrantEnv): Promise<Response> | undefined {
  const url = new URL(request.url);
  const matched = path.exec(url.pathname);
  if (matched) return handle(request, env, url, matched[1], matched[2]);
}

async function handle(request: Request, env: GrantEnv, url: URL, source: string, target?: string): Promise<Response> {
  if (!admitsSignInFixture(env)) return reply(404);
  const { method } = request;
  const listing = target === undefined;
  if (listing ? method !== 'GET' : method !== 'PUT' && method !== 'DELETE') {
    return new Response(null, { status: 405, headers: { ...headers, allow: listing ? 'GET' : 'PUT, DELETE' } });
  }
  if (!allowsOrigin(request, env.DRIVE_ORIGIN ?? '') || !allowsStagingInviteSite(request)) return reply(403);
  if (request.url !== url.origin + url.pathname + url.search) return reply(404);
  const entryId = decodeId(source);
  const recipientId = target === undefined ? null : decodeId(target);
  if (entryId === null || (!listing && recipientId === null)) return reply(404);
  const length = request.headers.get('content-length');
  // Workers can expose a stream for a request framed with Content-Length: 0.
  if (request.headers.has('transfer-encoding') || (length === null ? request.body !== null : length !== '0')) return reply(400);
  const after = listing && url.search.startsWith('?cursor=') ? decodeId(url.search.slice(8)) : null;
  if (url.search && after === null) return reply(400);

  const db = env.DB;
  if (!db || typeof db.withSession !== 'function') return reply(503);
  try {
    const session = await readSession(request, db);
    if (!session) return reply(401);
    // The lookup above classifies signed-out requests; only ReadGrants decides
    // whether the session can use this entry, in the same statement as the operation.
    const grants = new ReadGrants(db);
    if (recipientId === null) {
      const page = await grants.listPage(session.token, entryId, after);
      if (!page) return reply(404);
      const { recipients, nextCursor } = page;
      if (nextCursor !== null && !validId(nextCursor)) return reply(503);
      return Response.json({ recipients: recipients.map(({ recipientId }) => ({ recipientId })), nextCursor }, { headers });
    }
    const changed = method === 'PUT'
      ? await grants.create(session.token, entryId, recipientId)
      : await grants.revoke(session.token, entryId, recipientId);
    return reply(changed ? 204 : 404);
  } catch { return reply(503); }
}
