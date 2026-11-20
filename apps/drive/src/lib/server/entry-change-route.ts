import { isMetadataId, readMetadataJson } from './metadata-request';
import { moveSessionEntry, type EntryChange } from './metadata/move-entry';
import { validateName } from './metadata/private';
import { admitsSignInFixture, admitsStagingInvite, allowsOrigin, allowsStagingInviteSite, readSessionToken, type DriveAuthEnv } from './request-auth';

export type MetadataWriteEnv = DriveAuthEnv & { DB?: Parameters<typeof moveSessionEntry>[0] };
const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers: status === 405 ? { ...headers, allow: 'PATCH' } : headers });
const path = /^\/api\/entries\/([^/]+)$/;

function entryId(wire: string): string | null {
  if (wire.length > 1536) return null;
  try {
    const id = decodeURIComponent(wire);
    return isMetadataId(id) && encodeURIComponent(id).replaceAll("'", '%27') === wire ? id : null;
  } catch { return null; }
}

function parseChange(body: Record<string, unknown> | null): EntryChange | null {
  if (!body) return null;
  const { kind, parentId, name } = body;
  const fields = Object.keys(body);
  try {
    if (kind === 'rename' && fields.length === 2 && typeof name === 'string') {
      validateName(name);
      return { kind, name };
    }
    if (kind === 'move' && fields.every(field => field === 'kind' || field === 'parentId' || field === 'name') &&
        (parentId === null || isMetadataId(parentId))) {
      if (!Object.hasOwn(body, 'name')) return { kind, parentId };
      if (typeof name !== 'string') return null;
      validateName(name);
      return { kind, parentId, name };
    }
  } catch { return null; }
  return null;
}

export function entryChangeSource(request: Request, url: URL): string | null {
  const wireId = path.exec(url.pathname)?.[1];
  return wireId && request.url === url.origin + url.pathname ? entryId(wireId) : null;
}

export function entryChangeRequest(request: Request, env: MetadataWriteEnv): Promise<Response> | undefined {
  const url = new URL(request.url);
  if (path.test(url.pathname)) return patchEntry(request, env, url);
}

async function patchEntry(request: Request, env: MetadataWriteEnv, url: URL): Promise<Response> {
  if (!admitsSignInFixture(env) && !admitsStagingInvite(env)) return reply(404);
  if (request.method !== 'PATCH') return reply(405);
  if (!allowsOrigin(request, env.DRIVE_ORIGIN ?? '') || !allowsStagingInviteSite(request)) return reply(403);
  const sourceId = entryChangeSource(request, url);
  if (sourceId === null) return reply(404);
  const token = readSessionToken(request);
  if (!token) return reply(401);
  const db = env.DB;
  if (typeof db?.withSession !== 'function') return reply(503);
  const change = parseChange(await readMetadataJson(request, { uniqueFields: true }));
  if (!change || request.signal.aborted) return reply(400);
  try {
    const result = await moveSessionEntry(db, token, sourceId, change);
    if (typeof result === 'number') return reply(result);
    const { id, parentId, name, kind } = result;
    return Response.json({ id, parentId, name, kind }, { headers });
  } catch { return reply(503); }
}
