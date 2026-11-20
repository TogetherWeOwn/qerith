import { tokenHash } from '../identity/sessions';
import { validateName, type Entry } from './private';

interface Statement { bind(...values: (string | null)[]): Statement }
interface Database {
  withSession(constraint: 'first-primary'): {
    prepare(sql: string): Statement;
    batch<T>(statements: Statement[]): Promise<{ results: T[] }[]>;
  };
}

export type EntryChange = { kind: 'rename'; name: string } | { kind: 'move'; parentId: string | null; name?: string };
type UpdatedEntry = Pick<Entry, 'id' | 'kind' | 'name'> & { parentId: string | null };
type Denial = { status: 401 | 404 | 409 };

const candidate = `WITH RECURSIVE live AS (
  SELECT s.principal_id FROM drive_sessions s JOIN drive_active_members m ON m.id = s.principal_id
  WHERE s.token_hash = ?1 AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
), target AS (
  SELECT e.id, e.owner_id, e.kind, COALESCE(?5, e.name) AS name,
    CASE WHEN ?3 = 'rename' THEN e.parent_id ELSE ?4 END AS parent_id
  FROM drive_entries e JOIN live ON live.principal_id = e.owner_id WHERE e.id = ?2
), destination AS (
  SELECT t.* FROM target t WHERE t.parent_id IS NULL OR EXISTS (SELECT 1 FROM drive_entries p
    WHERE p.id = t.parent_id AND p.owner_id = t.owner_id AND p.kind = 'folder')
), ancestors(id, parent_id) AS (
  SELECT p.id, p.parent_id FROM destination d JOIN drive_entries p ON p.id = d.parent_id
  WHERE d.kind = 'folder'
  UNION
  SELECT p.id, p.parent_id FROM ancestors a JOIN drive_entries p ON p.id = a.parent_id
), candidate AS (
  SELECT d.id, d.parent_id, d.name, EXISTS (SELECT 1 FROM drive_entries sibling
    WHERE sibling.owner_id = d.owner_id AND COALESCE(sibling.parent_id, '') = COALESCE(d.parent_id, '')
      AND sibling.name = d.name AND sibling.id != d.id) AS conflicts
  FROM destination d WHERE NOT EXISTS (SELECT 1 FROM ancestors WHERE id = d.id)
)`;

// 409 is actionable only for a live owner and a valid destination. The schema
// triggers remain authoritative; unexpected database failures are not conflicts.
export async function moveSessionEntry(db: Database, token: string, id: string, change: EntryChange)
  : Promise<UpdatedEntry | 401 | 404 | 409> {
  const { kind, name } = change;
  if (kind !== 'rename' && kind !== 'move') throw new TypeError('Invalid entry change');
  const parentId = kind === 'move' ? change.parentId : null;
  if (parentId !== null && typeof parentId !== 'string') throw new TypeError('Invalid parent ID');
  if (kind === 'rename') validateName(name);
  else if (name !== undefined) validateName(name);
  const args = [await tokenHash(token), id, kind, parentId, name ?? null] as const;
  const primary = db.withSession('first-primary');
  // Derive the target in the write itself. Classify a refused write afterward,
  // inside the same D1 transaction, without relying on a prior session lookup.
  const [updated, denial] = await primary.batch<UpdatedEntry | Denial>([
    primary.prepare(`${candidate}
      UPDATE drive_entries SET parent_id = candidate.parent_id, name = candidate.name FROM candidate
      WHERE drive_entries.id = candidate.id AND NOT candidate.conflicts
      RETURNING id, parent_id AS parentId, name, kind`).bind(...args),
    primary.prepare(`${candidate}
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM live) THEN 401
        WHEN EXISTS (SELECT 1 FROM candidate WHERE conflicts) THEN 409 ELSE 404 END AS status`).bind(...args),
  ]);
  const entry = updated.results[0];
  if (entry && 'id' in entry) return entry;
  const reason = denial.results[0];
  if (!reason || !('status' in reason)) throw new Error('Missing metadata update result');
  return reason.status;
}
