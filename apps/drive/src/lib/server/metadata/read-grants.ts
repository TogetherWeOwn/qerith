interface Statement {
  bind(...values: string[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

export interface ReadGrantRecipient { recipientId: string }
export interface ReadGrantPage { recipients: ReadGrantRecipient[]; nextCursor: string | null }

const pageSize = 100;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

async function sessionHash(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Server-only primitives. The token is an authenticated session credential, not
// a principal ID. All authorization is checked in the same statement as use.
export class ReadGrants {
  constructor(private readonly db: Database & { withSession(constraint: 'first-primary'): Database }) {}

  // Null means the entry is unavailable; an empty page means the owner has no
  // more explicit grants. The cursor is only a seek boundary, never authority.
  async listPage(token: string, entryId: string, afterId: string | null = null): Promise<ReadGrantPage | null> {
    const hash = await sessionHash(token);
    if (!hash) return null;
    if (afterId !== null && typeof afterId !== 'string') throw new TypeError('Invalid grant page cursor');
    // Use the grant PK's (entry_id, recipient_id) order. The sentinel separates
    // an authorized empty page from denial without a second D1 operation.
    const { results } = await this.db.withSession('first-primary').prepare(`WITH owned AS (
      SELECT e.id, e.owner_id FROM drive_sessions s
      JOIN drive_principals owner ON owner.id = s.principal_id AND owner.status = 'active'
      JOIN drive_entries e ON e.id = ? AND e.owner_id = owner.id
      WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    ), page AS (
      SELECT g.recipient_id AS recipientId FROM drive_read_grants g
      WHERE g.entry_id = (SELECT id FROM owned) AND g.recipient_id > ?
        AND g.recipient_id != (SELECT owner_id FROM owned)
        AND EXISTS (SELECT 1 FROM drive_principals recipient WHERE recipient.id = g.recipient_id
          AND recipient.status = 'active' AND recipient.role = 'member')
      ORDER BY g.recipient_id LIMIT ${pageSize + 1}
    ) SELECT recipientId FROM page UNION ALL
      SELECT NULL FROM owned ORDER BY recipientId`)
      .bind(entryId, hash, afterId ?? '').all<ReadGrantRecipient | { recipientId: null }>();
    if (!results.some(row => row.recipientId === null)) return null;
    const items = results.filter(row => row.recipientId !== null);
    const recipients = items.slice(0, pageSize);
    return { recipients, nextCursor: items.length > pageSize ? recipients[pageSize - 1].recipientId : null };
  }

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
