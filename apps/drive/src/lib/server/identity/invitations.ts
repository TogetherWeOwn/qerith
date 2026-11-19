interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

const lifetimeMs = 7 * 24 * 60 * 60 * 1000;

type Display = { displayName: string | null; note: string | null };
type InvitationRow = { id: string | null; display_name: string | null; note: string | null; created_at: number | null; expires_at: number | null };

function optionalText(value: unknown, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max || value.includes('\0')) {
    throw new TypeError('Invalid invitation metadata');
  }
  return value;
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// The caller must supply a principal ID from a verified server-side session.
// This service checks live membership in the same D1 statement as each mutation.
export class Invitations {
  constructor(private readonly db: Database) {}

  async issue(ownerId: string, metadata: { displayName?: string | null; note?: string | null } = {}): Promise<{ id: string; token: string; expiresAt: number }> {
    const displayName = optionalText(metadata.displayName, 64);
    const note = optionalText(metadata.note, 140);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const hash = await tokenHash(token);
    const id = crypto.randomUUID();
    const row = await this.db.prepare(`INSERT INTO drive_invitations (id, token_hash, expires_at, display_name, note, created_at)
      SELECT ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?, ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE EXISTS (SELECT 1 FROM drive_principals WHERE id = ? AND role = 'owner' AND status = 'active')
      RETURNING expires_at`).bind(id, hash, lifetimeMs, displayName, note, ownerId).first<{ expires_at: number }>();
    if (!row) throw new Error('Invitation unavailable');
    return { id, token, expiresAt: row.expires_at };
  }

  async list(ownerId: string): Promise<{ id: string; displayName: string | null; note: string | null; createdAt: number | null; expiresAt: number }[]> {
    const { results } = await this.db.prepare(`SELECT i.id, i.display_name, i.note, i.created_at, i.expires_at
      FROM drive_principals p LEFT JOIN drive_invitations i ON i.cancelled_at IS NULL AND i.redeemed_at IS NULL
      WHERE p.id = ? AND p.role = 'owner' AND p.status = 'active'
      ORDER BY i.created_at DESC, i.id`).bind(ownerId).all<InvitationRow>();
    if (!results.length) throw new Error('Invitation unavailable');
    return results.flatMap(row => row.id === null || row.expires_at === null ? [] : [{
      id: row.id, displayName: row.display_name, note: row.note, createdAt: row.created_at, expiresAt: row.expires_at,
    }]);
  }

  async present(token: string): Promise<Display> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invitation unavailable');
    const row = await this.db.prepare(`SELECT display_name, note FROM drive_invitations WHERE token_hash = ?
      AND cancelled_at IS NULL AND redeemed_at IS NULL
      AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)`)
      .bind(await tokenHash(token)).first<{ display_name: string | null; note: string | null }>();
    if (!row) throw new Error('Invitation unavailable');
    return { displayName: row.display_name, note: row.note };
  }

  async cancel(ownerId: string, id: string): Promise<void> {
    const row = await this.db.prepare(`UPDATE drive_invitations
      SET cancelled_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE id = ? AND cancelled_at IS NULL AND redeemed_at IS NULL
        AND EXISTS (SELECT 1 FROM drive_principals WHERE id = ? AND role = 'owner' AND status = 'active')
      RETURNING id`).bind(id, ownerId).first<{ id: string }>();
    if (!row) throw new Error('Invitation unavailable');
  }
}
