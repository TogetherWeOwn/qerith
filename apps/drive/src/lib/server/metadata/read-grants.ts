interface Statement {
  bind(...values: string[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Database { prepare(sql: string): Statement }

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

async function sessionHash(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Server-only primitives. The token is an authenticated session credential, not
// a principal ID. All authorization is checked in the same statement as use.
export class ReadGrants {
  constructor(private readonly db: Database) {}

  async create(token: string, entryId: string, recipientId: string): Promise<boolean> {
    const hash = await sessionHash(token);
    if (!hash) return false;
    const row = await this.db.prepare(`INSERT INTO drive_read_grants (entry_id, recipient_id)
      SELECT e.id, recipient.id FROM drive_sessions s
      JOIN drive_principals owner ON owner.id = s.principal_id AND owner.status = 'active'
      JOIN drive_entries e ON e.owner_id = owner.id
      JOIN drive_principals recipient ON recipient.id = ? AND recipient.status = 'active'
        AND recipient.role = 'member' AND recipient.id != owner.id
      WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND e.id = ?
      ON CONFLICT (entry_id, recipient_id) DO NOTHING RETURNING entry_id`)
      .bind(recipientId, hash, entryId).first<{ entry_id: string }>();
    return row !== null;
  }

  async revoke(token: string, entryId: string, recipientId: string): Promise<boolean> {
    const hash = await sessionHash(token);
    if (!hash) return false;
    const row = await this.db.prepare(`DELETE FROM drive_read_grants
      WHERE entry_id = ? AND recipient_id = ? AND EXISTS (
        SELECT 1 FROM drive_entries e JOIN drive_sessions s ON s.principal_id = e.owner_id
        JOIN drive_principals owner ON owner.id = s.principal_id AND owner.status = 'active'
        WHERE e.id = drive_read_grants.entry_id AND s.token_hash = ?
          AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      ) RETURNING entry_id`).bind(entryId, recipientId, hash).first<{ entry_id: string }>();
    return row !== null;
  }

  // This answers only whether this session has an explicit grant. It does not
  // return metadata or authorize a later, separate read of an entry.
  async has(token: string, entryId: string): Promise<boolean> {
    const hash = await sessionHash(token);
    if (!hash) return false;
    const row = await this.db.prepare(`SELECT 1 AS permitted FROM drive_sessions s
      JOIN drive_principals recipient ON recipient.id = s.principal_id AND recipient.status = 'active'
      JOIN drive_read_grants g ON g.recipient_id = recipient.id
      JOIN drive_entries e ON e.id = g.entry_id
      JOIN drive_principals owner ON owner.id = e.owner_id AND owner.status = 'active'
      WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND e.id = ?`).bind(hash, entryId).first<{ permitted: number }>();
    return row !== null;
  }
}
