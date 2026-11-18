import { tokenHash } from '../identity/sessions';

interface Statement {
  bind(...values: (string | number)[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { withSession(constraint: 'first-primary'): { prepare(sql: string): Statement } }

export interface EligibleRecipient { recipientId: string }
export interface EligibleRecipientPage { recipients: EligibleRecipient[]; nextCursor: string | null }

const pageSize = 100;

// Server-only projection for the entry owner; a cursor is not authority.
export class EligibleRecipients {
  constructor(private readonly db: Database) {}

  async listPage(token: string, entryId: string, afterId: string | null = null): Promise<EligibleRecipientPage | null> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    if (afterId !== null && (typeof afterId !== 'string' || afterId.length > 512)) {
      throw new TypeError('Invalid recipient cursor');
    }
    const hash = await tokenHash(token);
    const { results } = await this.db.withSession('first-primary').prepare(`WITH owned AS (
      SELECT e.owner_id FROM drive_sessions s
      JOIN drive_principals owner ON owner.id = s.principal_id AND owner.status = 'active'
      JOIN drive_entries e ON e.owner_id = owner.id AND e.id = ?
      WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    ), page AS (
      SELECT p.id AS recipientId FROM drive_principals p
      WHERE p.id > (SELECT ? FROM owned) AND p.id != (SELECT owner_id FROM owned)
        AND p.status = 'active' AND p.role = 'member'
      ORDER BY p.id LIMIT ?
    ) SELECT recipientId FROM page UNION ALL SELECT NULL FROM owned ORDER BY recipientId`)
      .bind(entryId, hash, afterId ?? '', pageSize + 1).all<EligibleRecipient | { recipientId: null }>();
    if (!results.some(row => row.recipientId === null)) return null;
    const rows = results.filter(row => row.recipientId !== null);
    const recipients = rows.slice(0, pageSize);
    return { recipients, nextCursor: rows.length > pageSize ? recipients[pageSize - 1].recipientId : null };
  }
}
