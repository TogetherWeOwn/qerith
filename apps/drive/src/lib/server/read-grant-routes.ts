import { ReadGrants } from './metadata/read-grants';
import { decodeReadGrantId, readGrantCursor, readGrantPath, validReadGrantId } from './read-grant-admission';
import { admitsSignInFixture, admitsStagingReadGrants, allowsOrigin, allowsStagingInviteSite, readSession, type DriveAuthEnv } from './request-auth';

type GrantEnv = DriveAuthEnv & { DB?: ConstructorParameters<typeof ReadGrants>[0] };
const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers });

// Only the disposable fixture wrapper calls this entry point.
export function readGrantRequest(request: Request, env: GrantEnv): Promise<Response> | undefined {
  const url = new URL(request.url);
  const matched = readGrantPath.exec(url.pathname);
  if (matched) return admitsSignInFixture(env) ? handle(request, env, url, matched) : Promise.resolve(reply(404));
}

export function stagingReadGrantRequest(request: Request, env: GrantEnv, token: string | null): Response | Promise<Response> {
  if (!admitsStagingReadGrants(env)) return reply(404);
  const url = new URL(request.url);
  const matched = readGrantPath.exec(url.pathname);
  return matched ? handle(request, env, url, matched, token) : reply(404);
}

async function handle(request: Request, env: GrantEnv, url: URL, [, source, target]: RegExpExecArray,
  token?: string | null): Promise<Response> {
  const { method } = request;
  const listing = target === undefined;
  if (listing ? method !== 'GET' : method !== 'PUT' && method !== 'DELETE') {
    return new Response(null, { status: 405, headers: { ...headers, allow: listing ? 'GET' : 'PUT, DELETE' } });
  }
  if (!allowsOrigin(request, env.DRIVE_ORIGIN ?? '') || !allowsStagingInviteSite(request)) return reply(403);
  if (request.url !== url.origin + url.pathname + url.search) return reply(404);
  const entryId = decodeReadGrantId(source);
  const recipientId = target === undefined ? null : decodeReadGrantId(target);
  if (entryId === null || (!listing && recipientId === null)) return reply(404);
  const length = request.headers.get('content-length');
  // Workers can expose a stream for a request framed with Content-Length: 0.
  if (request.headers.has('transfer-encoding') || (length === null ? request.body !== null : length !== '0')) return reply(400);
  const after = readGrantCursor(method, url.search);
  if (after === undefined) return reply(400);

  const db = env.DB;
  if (!db || typeof db.withSession !== 'function') return reply(503);
  try {
    // Staging receives the token from the live hook lookup; the fixture has no hook.
    const current = token === undefined ? (await readSession(request, db))?.token : token;
    if (!current) return reply(401);
    // ReadGrants rechecks the session and entry ownership in the grant statement.
    const grants = new ReadGrants(db);
    if (recipientId === null) {
      const page = await grants.listPage(current, entryId, after);
      if (!page) return reply(404);
      const { recipients, nextCursor } = page;
      if (nextCursor !== null && !validReadGrantId(nextCursor)) return reply(503);
      return Response.json({ recipients: recipients.map(({ recipientId }) => ({ recipientId })), nextCursor }, { headers });
    }
    const changed = method === 'PUT'
      ? await grants.create(current, entryId, recipientId)
      : await grants.revoke(current, entryId, recipientId);
    return reply(changed ? 204 : 404);
  } catch { return reply(503); }
}
