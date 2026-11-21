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
  return typeof (db as Partial<PrimaryDatabase> | undefined)?.withSession === 'function';
}
type Row = { folderName: string; currentParentId: string | null; id: string | null; name: string | null };
export type MoveDestinations = {
  folderName: string; currentParentId: string | null;
  folders: { id: string; name: string }[]; next: string | null;
};

// Use a fresh primary statement to bind the source, destination and cursor to
// the same live principal. Unlike the folder document, this read honors no grants.
// Carry the listing context through one CTE to stay within D1's subquery nesting limit.
// Only a walk that reaches the root without crossing the source proves a destination.
const sql = `WITH RECURSIVE walk(id, parent_id, depth, owner_id, currentParentId, folderName, afterName) AS (
  SELECT f.id, f.parent_id, CASE WHEN f.id IS NULL THEN 0 ELSE 1 END,
    e.owner_id, e.parent_id, COALESCE(f.name, 'My Drive'), COALESCE(cursor.name, '')
  FROM drive_entries e
    JOIN drive_sessions s ON s.principal_id = e.owner_id
    JOIN drive_active_members m ON m.id = s.principal_id
    LEFT JOIN drive_entries f ON f.id = ?3 AND f.owner_id = e.owner_id AND f.kind = 'folder'
    LEFT JOIN drive_entries cursor ON cursor.id = ?4 AND cursor.owner_id = e.owner_id
      AND cursor.parent_id IS ?3 AND cursor.kind = 'folder'
  WHERE e.id = ?2 AND s.token_hash = ?1 AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND (?3 IS NULL OR f.id IS NOT NULL) AND (?4 IS NULL OR cursor.id IS NOT NULL)
  UNION ALL
  SELECT f.id, f.parent_id, a.depth + 1, a.owner_id, a.currentParentId, a.folderName, a.afterName
  FROM walk a JOIN drive_entries f ON f.id = a.parent_id AND f.owner_id = a.owner_id AND f.kind = 'folder'
  WHERE a.depth < ${maxDepth} AND a.id <> ?2
)
SELECT a.folderName, a.currentParentId, c.id, c.name
FROM walk a LEFT JOIN drive_entries c ON c.id IN (
  SELECT id FROM drive_entries INDEXED BY drive_entries_listing_asc
  WHERE a.depth < ${maxDepth} AND owner_id = a.owner_id AND parent_id IS ?3 AND kind = 'folder'
    AND name COLLATE BINARY > a.afterName
    AND length(id) <= 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
  ORDER BY name COLLATE BINARY LIMIT ${pageSize + 1}
)
WHERE a.parent_id IS NULL AND a.id IS NOT ?2 AND (?4 IS NULL OR a.depth < ${maxDepth})
ORDER BY c.name COLLATE BINARY`;

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
