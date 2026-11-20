import { isMetadataId, readMetadataJson } from './metadata-request';
import { createSessionFolder } from './metadata/create-folder';
import { validateName } from './metadata/private';
import { admitsSignInFixture, allowsOrigin, readSessionToken, type DriveAuthEnv } from './request-auth';

type FolderEnv = DriveAuthEnv & { DB?: { withSession(constraint: 'first-primary'): Parameters<typeof createSessionFolder>[0] } };
const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers: status === 405 ? { ...headers, allow: 'POST' } : headers });

async function readFolderBody(request: Request): Promise<{ name: string; parentId: string | null } | null> {
  const body = await readMetadataJson(request);
  if (!body || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'name') || !Object.hasOwn(body, 'parentId')) return null;
  const { name, parentId } = body;
  if (typeof name !== 'string' || (parentId !== null && !isMetadataId(parentId))) return null;
  try { validateName(name); } catch { return null; }
  return { name, parentId };
}

export async function postFolder(request: Request, env: FolderEnv): Promise<Response> {
  if (!admitsSignInFixture(env)) return reply(404);
  if (request.method !== 'POST') return reply(405);
  const site = request.headers.get('sec-fetch-site');
  if (!allowsOrigin(request, env.DRIVE_ORIGIN ?? '') || (site !== null && site !== 'same-origin')) return reply(403);
  if (request.url !== `${env.DRIVE_ORIGIN}/api/folders`) return reply(404);
  const token = readSessionToken(request);
  if (!token) return reply(401);
  const db = env.DB;
  if (typeof db?.withSession !== 'function') return reply(503);
  const input = await readFolderBody(request);
  if (!input || request.signal.aborted) return reply(400);
  try {
    const folder = await createSessionFolder(db.withSession('first-primary'), token, input.parentId, input.name);
    if (typeof folder === 'number') return reply(folder);
    const { id, parentId, name, kind } = folder;
    return Response.json({ id, parentId, name, kind }, { status: 201, headers });
  } catch { return reply(503); }
}
