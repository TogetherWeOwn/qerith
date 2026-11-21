import { isLinkableFolderId } from '../drive-navigation';
import { entryChangePath } from '../metadata-id';
import { tokenHash } from './identity/sessions';
import { admitsStagingInvite, allowsOrigin, allowsStagingInviteSite, readSessionToken, type DriveAuthEnv } from './request-auth';

export const moveDestinationsPath = '/api/move-destinations';
const pageSize = 50;
const maxDepth = 64;
const headers = { 'cache-control': 'private, no-store' };
const deny = (status: number) => new Response(null, { status, headers });

interface PrimaryDatabase {
  withSession(constraint: 'first-primary'): {
    prepare(sql: string): { bind(...params: (string | null)[]): { all<T>(): Promise<{ results: T[] }> } };
  };
}
function hasPrimary(db: DriveAuthEnv['DB']): db is NonNullable<DriveAuthEnv['DB']> & PrimaryDatabase {
  return !!db && 'withSession' in db && typeof db.withSession === 'function';
}
type Row = { folderName: string; currentParentId: string | null; id: string | null; name: string | null };
export type MoveDestinations = {
  folderName: string; currentParentId: string | null;
  folders: { id: string; name: string }[]; next: string | null;
};

// Use a fresh primary statement to bind the source, destination and cursor to
// the same live principal. Unlike the folder document, this read honors no grants.
// The ancestry walk fails closed if it can't prove a path to the root within the bound.
const sql = `WITH RECURSIVE source AS (
  SELECT e.owner_id, e.parent_id FROM drive_entries e
    JOIN drive_sessions s ON s.principal_id = e.owner_id
    JOIN drive_active_members m ON m.id = s.principal_id
  WHERE e.id = ?2 AND s.token_hash = ?1 AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
), ancestors(id, parent_id, depth) AS (
  SELECT f.id, f.parent_id, 1 FROM source JOIN drive_entries f
    ON f.id = ?3 AND f.owner_id = source.owner_id AND f.kind = 'folder'
  UNION ALL
  SELECT f.id, f.parent_id, a.depth + 1 FROM ancestors a JOIN drive_entries f ON f.id = a.parent_id
    JOIN source ON f.owner_id = source.owner_id
  WHERE a.depth < ${maxDepth} AND f.kind = 'folder'
), destination AS (
  SELECT source.owner_id, source.parent_id AS currentParentId, COALESCE(f.name, 'My Drive') AS folderName
  FROM source LEFT JOIN drive_entries f ON f.id = ?3
  WHERE ?3 IS NULL OR (EXISTS (SELECT 1 FROM ancestors WHERE parent_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM ancestors WHERE id = ?2))
), boundary AS (
  SELECT e.name FROM destination d JOIN drive_entries e ON e.id = ?4
    AND e.owner_id = d.owner_id AND e.parent_id IS ?3 AND e.kind = 'folder'
), children AS (
  SELECT id, name FROM drive_entries
  WHERE owner_id = (SELECT owner_id FROM destination) AND parent_id IS ?3 AND kind = 'folder'
    AND name > COALESCE((SELECT name FROM boundary), '')
    AND length(id) <= 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
  ORDER BY name LIMIT ${pageSize + 1}
)
SELECT d.folderName, d.currentParentId, c.id, c.name FROM destination d LEFT JOIN children c ON TRUE
WHERE ?4 IS NULL OR EXISTS (SELECT 1 FROM boundary)
ORDER BY c.name`;

export async function getMoveDestinations(request: Request, env: DriveAuthEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!admitsStagingInvite(env) || request.method !== 'GET' || url.pathname !== moveDestinationsPath) return deny(404);
  if (!allowsOrigin(request, env.DRIVE_ORIGIN ?? '') || !allowsStagingInviteSite(request)) return deny(403);
  if (request.url !== url.origin + moveDestinationsPath + url.search || url.search.length > 4096) return deny(400);
  try { decodeURIComponent(url.search); } catch { return deny(400); }
  const params = url.searchParams;
  if ([...params.keys()].some(key => !['entry', 'folder', 'after'].includes(key) || params.getAll(key).length !== 1)) return deny(400);
  const entry = params.get('entry') ?? '', folder = params.get('folder'), after = params.get('after');
  if (!entryChangePath(entry) || [folder, after].some(id => id !== null && !isLinkableFolderId(id))) return deny(400);
  const token = readSessionToken(request);
  if (!token) return deny(401);
  const db = env.DB;
  if (!hasPrimary(db)) return deny(503);
  try {
    const { results } = await db.withSession('first-primary').prepare(sql).bind(await tokenHash(token), entry, folder, after).all<Row>();
    const destination = results[0];
    if (!destination) return deny(404);
    const folders = results.slice(0, pageSize).flatMap(({ id, name }) => id !== null && name !== null ? [{ id, name }] : []);
    const body: MoveDestinations = { folderName: destination.folderName, currentParentId: destination.currentParentId,
      folders, next: results.length > pageSize ? folders.at(-1)!.id : null };
    return Response.json(body, { headers });
  } catch { return deny(503); }
}
