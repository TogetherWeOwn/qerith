import { EligibleRecipients } from './metadata/eligible-recipients';
import { eligibleRecipientEntry, eligibleRecipientsPath, readGrantCursor, validReadGrantId } from './read-grant-admission';
import { admitsEligibleRecipients, allowsOrigin, allowsStagingInviteSite, type DriveAuthEnv } from './request-auth';

type RecipientEnv = DriveAuthEnv & { DB?: ConstructorParameters<typeof EligibleRecipients>[0] };
const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers });

function admit(request: Request, url: URL, env: DriveAuthEnv) {
  if (!admitsEligibleRecipients(env)) return reply(404);
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET' } });
  if (!allowsOrigin(request, env.DRIVE_ORIGIN ?? '') || !allowsStagingInviteSite(request)) return reply(403);
  const entryId = eligibleRecipientEntry(request, url);
  if (entryId === null) return reply(404);
  const length = request.headers.get('content-length');
  if (request.headers.has('transfer-encoding') || (length === null ? request.body !== null : length !== '0')) return reply(400);
  const after = readGrantCursor(request.method, url.search);
  return after === undefined ? reply(400) : { entryId, after };
}

// Own the recipient path and its descendants before SvelteKit processes its internal suffixes or query keys.
export function dispatchEligibleRecipients(request: Request, env: DriveAuthEnv, adapter: (request: Request) => Promise<Response>) {
  const url = new URL(request.url);
  let pathname = url.pathname;
  try { pathname = decodeURI(pathname); } catch { /* Validate the raw path below. */ }
  const match = eligibleRecipientsPath.exec(pathname);
  if (!match) return null;
  if (match[0] !== pathname) return reply(404);
  const admission = admit(request, url, env);
  return admission instanceof Response ? admission : adapter(request);
}

// The adapter hook supplies the session for the fixture and opted-in staging.
export async function getEligibleRecipients(request: Request, env: RecipientEnv, token: string | null): Promise<Response> {
  const admission = admit(request, new URL(request.url), env);
  if (admission instanceof Response) return admission;
  const { entryId, after } = admission;
  if (!token) return reply(401);
  const db = env.DB;
  if (!db || typeof db.withSession !== 'function') return reply(503);
  try {
    // The session from the hook is not authority: the service rechecks it and ownership in D1.
    const page = await new EligibleRecipients(db).listPage(token, entryId, after);
    if (!page) return reply(404);
    const { recipients, nextCursor } = page;
    if (nextCursor !== null && !validReadGrantId(nextCursor)) return reply(503);
    return Response.json({
      recipients: recipients.map(({ recipientId, displayName, direct, inheritedFrom }) => ({ recipientId, displayName, direct, inheritedFrom })),
      nextCursor,
    }, { headers });
  } catch { return reply(503); }
}
