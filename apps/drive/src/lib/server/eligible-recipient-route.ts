import { EligibleRecipients } from './metadata/eligible-recipients';
import { decodeReadGrantId, readGrantCursor, validReadGrantId } from './read-grant-admission';
import { admitsSignInFixture, allowsOrigin, allowsStagingInviteSite, type DriveAuthEnv } from './request-auth';

type RecipientEnv = DriveAuthEnv & { DB?: ConstructorParameters<typeof EligibleRecipients>[0] };
const path = /^\/api\/entries\/([^/]{1,1536})\/eligible-recipients$/;
const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers });

// Source-only until explicitly admitted. Only the disposable fixture may serve it.
export async function getEligibleRecipients(request: Request, env: RecipientEnv, token: string | null): Promise<Response> {
  if (!admitsSignInFixture(env)) return reply(404);
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET' } });
  if (!allowsOrigin(request, env.DRIVE_ORIGIN ?? '') || !allowsStagingInviteSite(request)) return reply(403);
  const url = new URL(request.url);
  const match = path.exec(url.pathname);
  if (!match || request.url !== url.origin + url.pathname + url.search) return reply(404);
  const entryId = decodeReadGrantId(match[1]);
  if (entryId === null) return reply(404);
  const length = request.headers.get('content-length');
  if (request.headers.has('transfer-encoding') || (length === null ? request.body !== null : length !== '0')) return reply(400);
  const after = readGrantCursor(request.method, url.search);
  if (after === undefined) return reply(400);
  if (!token) return reply(401);
  const db = env.DB;
  if (!db || typeof db.withSession !== 'function') return reply(503);
  try {
    // The session from the hook is not authority: the service rechecks it and ownership in D1.
    const page = await new EligibleRecipients(db).listPage(token, entryId, after);
    if (!page) return reply(404);
    const { recipients, nextCursor } = page;
    if (nextCursor !== null && !validReadGrantId(nextCursor)) return reply(503);
    return Response.json({ recipients: recipients.map(({ recipientId, displayName }) => ({ recipientId, displayName })), nextCursor }, { headers });
  } catch { return reply(503); }
}
