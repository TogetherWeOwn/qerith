import { tokenHash } from '../identity/sessions';

interface Statement {
  bind(...values: (string | number)[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { withSession(constraint: 'first-primary'): { prepare(sql: string): Statement } }

// An unnamed account has no label; callers must not derive one from recipientId.
export interface EligibleRecipient {
  recipientId: string;
  displayName: string | null;
  direct: boolean;
  inheritedFrom: string | null;
}
export interface EligibleRecipientPage { recipients: EligibleRecipient[]; nextCursor: string | null }

type PageRow = Omit<EligibleRecipient, 'direct'> & { direct: 0 | 1 };

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
    // UNION over stable entry fields, as in read-access, stops even if the tree has a cycle.
    const { results } = await this.db.withSession('first-primary').prepare(`WITH RECURSIVE owned AS (
      SELECT e.id, e.parent_id, e.owner_id, e.kind, e.name FROM drive_sessions s
      JOIN drive_principals owner ON owner.id = s.principal_id AND owner.status = 'active'
      JOIN drive_entries e ON e.owner_id = owner.id AND e.id = ?
      WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    ), ancestors AS (
      SELECT id, parent_id, owner_id, kind, name FROM owned
      UNION
      SELECT e.id, e.parent_id, e.owner_id, e.kind, e.name FROM drive_entries e
      JOIN ancestors a ON e.id = a.parent_id AND e.owner_id = a.owner_id
    ), page AS (
      SELECT p.id AS recipientId, p.display_name AS displayName FROM drive_principals p
      WHERE p.id > (SELECT ? FROM owned) AND p.id != (SELECT owner_id FROM owned)
        AND p.status = 'active' AND p.role = 'member'
      ORDER BY p.id LIMIT ?
    ) SELECT recipientId, displayName,
      EXISTS (SELECT 1 FROM drive_read_grants g WHERE g.entry_id = (SELECT id FROM owned)
        AND g.recipient_id = page.recipientId) AS direct,
      (SELECT a.name FROM ancestors a WHERE a.id != (SELECT id FROM owned) AND a.kind = 'folder'
        AND EXISTS (SELECT 1 FROM drive_read_grants g WHERE g.entry_id = a.id AND g.recipient_id = page.recipientId)
        ORDER BY a.id LIMIT 1) AS inheritedFrom
    FROM page UNION ALL SELECT NULL, NULL, NULL, NULL FROM owned ORDER BY recipientId`)
      .bind(entryId, hash, afterId ?? '', pageSize + 1).all<PageRow | { recipientId: null }>();
    if (!results.some(row => row.recipientId === null)) return null;
    const rows = results.filter(row => row.recipientId !== null);
    const recipients = rows.slice(0, pageSize).map(row => ({ ...row, direct: row.direct === 1 }));
    return { recipients, nextCursor: rows.length > pageSize ? recipients[pageSize - 1].recipientId : null };
  }
}
