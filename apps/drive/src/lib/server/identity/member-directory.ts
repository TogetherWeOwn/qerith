import { tokenHash } from './sessions';

interface Statement {
  bind(...values: (string | number)[]): Statement;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { withSession(constraint: 'first-primary'): { prepare(sql: string): Statement } }

export interface DirectoryMember {
  id: string;
  role: 'owner' | 'member';
  status: 'active' | 'revoked';
  usageBytes: string;
}
export interface MemberDirectoryPage { members: DirectoryMember[]; nextCursor: string | null }

const pageSize = 100;

// Server-only projection. Display names and last sign-in aren't persisted on accounts.
export class MemberDirectory {
  constructor(private readonly db: Database) {}

  // Null means unauthorized; an empty page means the owner reached the end.
  // The cursor is only a seek boundary, not a snapshot or an authorization token.
  async listPage(token: string, afterId: string | null = null): Promise<MemberDirectoryPage | null> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    if (afterId !== null && (typeof afterId !== 'string' || afterId.length > 512)) {
      throw new TypeError('Invalid member directory cursor');
    }
    const hash = await tokenHash(token);
    // Without authorization the scalar seek key is NULL, so there is no ID range to read.
    const { results } = await this.db.withSession('first-primary').prepare(`WITH authorized AS (
      SELECT 1 FROM drive_sessions s
      JOIN drive_principals p ON p.id = s.principal_id
      WHERE s.token_hash = ? AND s.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND p.role = 'owner' AND p.status = 'active'
    ), page AS (
      SELECT id, role, status FROM drive_principals
      WHERE id > (SELECT ? FROM authorized)
      ORDER BY id LIMIT ?
    ) SELECT page.id, page.role, page.status,
      CAST(COALESCE(u.high, 0) AS TEXT) || printf('%09d', COALESCE(u.low, 0)) AS usageBytes
      FROM page LEFT JOIN drive_owner_usage u ON u.owner_id = page.id
    UNION ALL SELECT NULL, NULL, NULL, NULL FROM authorized ORDER BY id`)
      .bind(hash, afterId ?? '', pageSize + 1).all<DirectoryMember | { id: null }>();
    if (!results.some(row => row.id === null)) return null;
    const rows = results.filter(row => row.id !== null);
    const members = rows.slice(0, pageSize);
    for (const member of members) member.usageBytes = member.usageBytes.replace(/^0+(?=\d)/, '');
    return { members, nextCursor: rows.length > pageSize ? members[pageSize - 1].id : null };
  }
}
