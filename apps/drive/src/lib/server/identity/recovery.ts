interface Statement {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Database { prepare(sql: string): Statement }

const lifetimeMs = 24 * 60 * 60 * 1000;

async function hashToken(token: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The owner session is checked in the mutation itself, not merely before it.
// This boundary issues and cancels tokens; it does not implement redemption.
export class RecoveryTokens {
  constructor(private readonly db: Database) {}

  async issue(sessionToken: string, principalId: string): Promise<{ id: string; token: string; expiresAt: number }> {
    if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw new Error('Recovery unavailable');
    const sessionHash = await hashToken(sessionToken);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const hash = await hashToken(token);
    const id = crypto.randomUUID();
    const row = await this.db.prepare(`INSERT INTO drive_recovery_tokens (id, principal_id, token_hash, expires_at)
      SELECT ?, ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?
      WHERE EXISTS (SELECT 1 FROM drive_sessions s JOIN drive_principals p ON p.id = s.principal_id
        WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND p.role = 'owner' AND p.status = 'active')
        AND EXISTS (SELECT 1 FROM drive_principals WHERE id = ? AND status = 'active')
      RETURNING expires_at`).bind(id, principalId, hash, lifetimeMs, sessionHash, principalId).first<{ expires_at: number }>();
    if (!row) throw new Error('Recovery unavailable');
    return { id, token, expiresAt: row.expires_at };
  }

  async cancel(sessionToken: string, id: string): Promise<void> {
    if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw new Error('Recovery unavailable');
    const sessionHash = await hashToken(sessionToken);
    const row = await this.db.prepare(`UPDATE drive_recovery_tokens
      SET cancelled_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE id = ? AND cancelled_at IS NULL AND redeemed_at IS NULL
        AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND EXISTS (SELECT 1 FROM drive_sessions s JOIN drive_principals p ON p.id = s.principal_id
          WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
            AND p.role = 'owner' AND p.status = 'active')
      RETURNING id`).bind(id, sessionHash).first<{ id: string }>();
    if (!row) throw new Error('Recovery unavailable');
  }
}
