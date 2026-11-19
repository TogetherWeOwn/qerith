import { env } from 'cloudflare:workers';
import { InvalidInvitationMetadata, InvitationUnavailable } from './identity/invitations';
import { admitsSignInFixture, stagingOrigin } from './request-auth';
import { readUploadBody } from './upload-part';

type Database = NonNullable<typeof env.DB>;
export const ownerReply = (status: number) => new Response(null, { status, headers: { 'cache-control': 'private, no-store' } });
export const ownerResourceId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export async function ownerAction({ request, locals }: { request: Request; locals: App.Locals },
  action: (db: Database, token: string) => Promise<Response>): Promise<Response> {
  // The private request hook has already checked Origin and looked up the live session.
  if (env.DRIVE_ORIGIN === stagingOrigin || admitsSignInFixture(env)) return ownerReply(404);
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') return ownerReply(403);
  const session = locals.driveSession;
  if (!session) return ownerReply(401);
  if (session.principal.role !== 'owner') return ownerReply(403);
  if (!env.DB) return ownerReply(503);
  try {
    return await action(env.DB, session.token);
  } catch (error) {
    if (error instanceof InvalidInvitationMetadata) return ownerReply(400);
    if (error instanceof InvitationUnavailable) return ownerReply(404);
    return ownerReply(503);
  }
}

export async function readInviteMetadata(request: Request): Promise<{ displayName?: unknown; note?: unknown } | null> {
  if (request.headers.get('content-type') !== 'application/json') return null;
  const length = request.headers.get('content-length');
  if (!length || !/^[1-9][0-9]{0,3}$/.test(length) || Number(length) > 3072) return null;
  try {
    const bytes = await readUploadBody(request, Number(length));
    if (!bytes) return null;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => key !== 'displayName' && key !== 'note')) return null;
    return value;
  } catch { return null; }
}
