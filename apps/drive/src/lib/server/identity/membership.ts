interface Statement {
  bind(...values: string[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Database { prepare(sql: string): Statement }

export interface ActivePrincipal {
  id: string;
  role: 'owner' | 'member';
}

export interface MemberState {
  status: 'active' | 'revoked';
  generation: string;
}

async function sessionHash(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The generation is an optimistic concurrency token, not an authorization credential.
// A fresh owner-authorized read is required before each status change.
export class Membership {
  constructor(private readonly db: Database) {}

  async get(sessionToken: string, principalId: string): Promise<MemberState | null> {
    const hash = await sessionHash(sessionToken);
    if (!hash || typeof principalId !== 'string') return null;
    return this.db.prepare(`SELECT target.status, g.generation FROM drive_principals target
      JOIN drive_login_generations g ON g.principal_id = target.id
      WHERE target.id = ? AND target.role = 'member' AND EXISTS (
        SELECT 1 FROM drive_sessions s JOIN drive_principals owner ON owner.id = s.principal_id
        WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND owner.role = 'owner' AND owner.status = 'active'
      )`).bind(principalId, hash).first<MemberState>();
  }

  async setStatus(sessionToken: string, principalId: string, generation: string, status: MemberState['status']): Promise<boolean> {
    const hash = await sessionHash(sessionToken);
    if (!hash || typeof principalId !== 'string' || typeof generation !== 'string'
      || !/^[a-f0-9]{64}$/.test(generation) || (status !== 'active' && status !== 'revoked')) return false;
    const row = await this.db.prepare(`UPDATE drive_principals SET status = ?
      WHERE id = ? AND role = 'member' AND status != ?
        AND EXISTS (SELECT 1 FROM drive_login_generations g
          WHERE g.principal_id = drive_principals.id AND g.generation = ?)
        AND EXISTS (SELECT 1 FROM drive_sessions s JOIN drive_principals owner ON owner.id = s.principal_id
          WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
            AND owner.role = 'owner' AND owner.status = 'active' AND owner.id != drive_principals.id)
      RETURNING id`).bind(status, principalId, status, generation, hash).first<{ id: string }>();
    return row !== null;
  }
}

// A caller-supplied ID is not authentication; callers must establish identity separately.
export async function findActivePrincipal(db: Database, id: string): Promise<ActivePrincipal | null> {
  return db.prepare(`SELECT id, role FROM drive_principals WHERE id = ? AND status = 'active'`)
    .bind(id).first<ActivePrincipal>();
}
