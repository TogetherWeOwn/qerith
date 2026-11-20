import { tokenHash } from '../identity/sessions';
import { validateName, type Entry } from './private';

interface Statement { bind(...values: (string | null)[]): Statement }
interface Database {
  prepare(sql: string): Statement;
  batch<T>(statements: Statement[]): Promise<{ results: T[] }[]>;
}

type Folder = Pick<Entry, 'id' | 'name'> & { parentId: string | null; kind: 'folder' };
type Denial = { status: 404 | 409 };

const live = `FROM drive_sessions s JOIN drive_active_members m ON m.id = s.principal_id
  WHERE s.token_hash = ?1 AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)`;
const ownsParent = `(?2 IS NULL OR EXISTS (SELECT 1 FROM drive_entries p
  WHERE p.id = ?2 AND p.owner_id = s.principal_id AND p.kind = 'folder'))`;
const siblingExists = `EXISTS (SELECT 1 FROM drive_entries e
  WHERE e.owner_id = s.principal_id AND COALESCE(e.parent_id, '') = COALESCE(?2, '') AND e.name = ?3)`;

export async function createSessionFolder(db: Database, token: string, parentId: string | null, name: string)
  : Promise<Folder | 401 | 404 | 409> {
  validateName(name);
  const args = [await tokenHash(token), parentId, name] as const;
  // Classify conflicts in the same transaction, without relying on D1 error strings.
  // The insert independently requires live authority and an owned folder parent.
  const [denial, created] = await db.batch<Denial | Folder>([
    db.prepare(`SELECT CASE WHEN ${ownsParent} AND ${siblingExists} THEN 409 ELSE 404 END AS status ${live}`)
      .bind(...args),
    db.prepare(`INSERT INTO drive_entries (id, owner_id, parent_id, name, kind)
      SELECT ?4, s.principal_id, ?2, ?3, 'folder' ${live} AND ${ownsParent} AND NOT ${siblingExists}
      RETURNING id, parent_id AS parentId, name, kind`)
      .bind(...args, crypto.randomUUID()),
  ]);
  const folder = created.results[0];
  const reason = denial.results[0];
  if (folder && 'id' in folder) return folder;
  return reason && 'status' in reason ? reason.status : 401;
}
