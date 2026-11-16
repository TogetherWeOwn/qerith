interface Statement {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Database { prepare(sql: string): Statement }

const lifetimeMs = 7 * 24 * 60 * 60 * 1000;

// The caller must supply a principal ID from a verified server-side session.
// This service checks live membership in the same D1 statement as each mutation.
export class Invitations {
  constructor(private readonly db: Database) {}

  async issue(ownerId: string): Promise<{ id: string; token: string; expiresAt: number }> {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
    const id = crypto.randomUUID();
    const row = await this.db.prepare(`INSERT INTO drive_invitations (id, token_hash, expires_at)
      SELECT ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?
      WHERE EXISTS (SELECT 1 FROM drive_principals WHERE id = ? AND role = 'owner' AND status = 'active')
      RETURNING expires_at`).bind(id, hash, lifetimeMs, ownerId).first<{ expires_at: number }>();
    if (!row) throw new Error('Invitation unavailable');
    return { id, token, expiresAt: row.expires_at };
  }

  async cancel(ownerId: string, id: string): Promise<void> {
    const row = await this.db.prepare(`UPDATE drive_invitations
      SET cancelled_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE id = ? AND cancelled_at IS NULL AND redeemed_at IS NULL
        AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND EXISTS (SELECT 1 FROM drive_principals WHERE id = ? AND role = 'owner' AND status = 'active')
      RETURNING id`).bind(id, ownerId).first<{ id: string }>();
    if (!row) throw new Error('Invitation unavailable');
  }
}
