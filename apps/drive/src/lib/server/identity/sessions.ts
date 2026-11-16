interface Statement {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

const lifetimeMs = 12 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Server-only primitive, not an authentication endpoint. issue() may be called only
// after a trusted server-side authentication ceremony has verified principalId;
// neither a caller-supplied ID nor active membership alone proves authentication.
export class Sessions {
  constructor(private readonly db: Database) {}

  async issue(principalId: string): Promise<{ token: string; expiresAt: number }> {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const hash = await tokenHash(token);
    const row = await this.db.prepare(`INSERT INTO drive_sessions (token_hash, principal_id, expires_at)
      SELECT ?, id, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ? FROM drive_principals
      WHERE id = ? AND status = 'active' RETURNING expires_at`)
      .bind(hash, lifetimeMs, principalId).first<{ expires_at: number }>();
    if (!row) throw new Error('Session unavailable');
    return { token, expiresAt: row.expires_at };
  }

  async lookup(token: string): Promise<{ id: string; role: 'owner' | 'member' } | null> {
    if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
    const hash = await tokenHash(token);
    return this.db.prepare(`SELECT p.id, p.role FROM drive_sessions s
      JOIN drive_principals p ON p.id = s.principal_id
      WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND p.status = 'active'`).bind(hash).first<{ id: string; role: 'owner' | 'member' }>();
  }

  // Trusted server maintenance only: one atomic, indexed batch per invocation.
  // Repeat while 100 rows are returned; no scheduler or endpoint is implied.
  async cleanupExpired(): Promise<number> {
    const deleted = await this.db.prepare(`DELETE FROM drive_sessions WHERE token_hash IN (
      SELECT token_hash FROM drive_sessions
      WHERE expires_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
      ORDER BY expires_at, token_hash LIMIT 100
    ) RETURNING token_hash`).all<{ token_hash: string }>();
    return deleted.results.length;
  }

  async revoke(token: string): Promise<void> {
    if (typeof token !== 'string' || !tokenPattern.test(token)) return;
    const hash = await tokenHash(token);
    await this.db.prepare('DELETE FROM drive_sessions WHERE token_hash = ? RETURNING token_hash')
      .bind(hash).first<{ token_hash: string }>();
  }
}
