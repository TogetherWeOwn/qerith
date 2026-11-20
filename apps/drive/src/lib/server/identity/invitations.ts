import { tokenHash } from './sessions';

interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
interface Database { prepare(sql: string): Statement }

const lifetimeMs = 7 * 24 * 60 * 60 * 1000;
const now = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const liveOwner = `FROM drive_sessions s JOIN drive_principals p ON p.id = s.principal_id
  WHERE s.token_hash = ? AND s.expires_at > ${now} AND p.role = 'owner' AND p.status = 'active'`;

export class InvalidInvitationMetadata extends Error {}
export class InvitationUnavailable extends Error {
  constructor() { super('Invitation unavailable'); }
}

async function ownerSessionHash(token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new InvitationUnavailable();
  return tokenHash(token);
}

type Display = { displayName: string | null; note: string | null };
type InvitationRow = { id: string | null; display_name: string | null; note: string | null; created_at: number | null;
  expires_at: number | null; cancelled_at: number | null; redeemed_at: number | null };
const pageSize = 100;

function optionalText(value: unknown, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > max || value.includes('\0')) {
    throw new InvalidInvitationMetadata();
  }
  return value;
}

// Owner operations check the session and live role in the same D1 statement.
export class Invitations {
  constructor(private readonly db: Database) {}

  async issue(ownerToken: string, metadata: { displayName?: unknown; note?: unknown } = {}): Promise<{ id: string; token: string; expiresAt: number }> {
    const displayName = optionalText(metadata.displayName, 64);
    const note = optionalText(metadata.note, 140);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const hash = await tokenHash(token);
    const id = crypto.randomUUID();
    const row = await this.db.prepare(`INSERT INTO drive_invitations (id, token_hash, expires_at, display_name, note, created_at)
      SELECT ?, ?, ${now} + ?, ?, ?, ${now} WHERE EXISTS (SELECT 1 ${liveOwner})
      RETURNING expires_at`).bind(id, hash, lifetimeMs, displayName, note, await ownerSessionHash(ownerToken)).first<{ expires_at: number }>();
    if (!row) throw new InvitationUnavailable();
    return { id, token, expiresAt: row.expires_at };
  }

  async list(ownerToken: string, afterId = '') {
    // Page the primary key before filtering. Even a long cancelled/redeemed
    // history costs at most one page of rows per request. An empty page can advance.
    const { results } = await this.db.prepare(`WITH owner AS (SELECT 1 ${liveOwner}), page AS (
      SELECT id, display_name, note, created_at, expires_at, cancelled_at, redeemed_at FROM drive_invitations
      WHERE id > (SELECT ? FROM owner) ORDER BY id LIMIT ?
    ) SELECT page.* FROM owner LEFT JOIN page ON TRUE ORDER BY id`)
      .bind(await ownerSessionHash(ownerToken), afterId, pageSize + 1).all<InvitationRow>();
    if (!results.length) throw new InvitationUnavailable();
    // Keep expired invitations visible for removal; the expiry still forbids enrollment.
    const invitations = results.slice(0, pageSize).flatMap(row =>
      row.id === null || row.expires_at === null || row.cancelled_at !== null || row.redeemed_at !== null ? [] : [{
        id: row.id, displayName: row.display_name, note: row.note, createdAt: row.created_at, expiresAt: row.expires_at,
      }]);
    return { invitations, nextCursor: results.length > pageSize ? results[pageSize - 1].id : null };
  }

  async present(token: string): Promise<Display> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new InvitationUnavailable();
    const row = await this.db.prepare(`SELECT display_name, note FROM drive_invitations WHERE token_hash = ?
      AND cancelled_at IS NULL AND redeemed_at IS NULL
      AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)`)
      .bind(await tokenHash(token)).first<{ display_name: string | null; note: string | null }>();
    if (!row) throw new InvitationUnavailable();
    return { displayName: row.display_name, note: row.note };
  }

  async cancel(ownerToken: string, id: string): Promise<void> {
    const row = await this.db.prepare(`UPDATE drive_invitations SET cancelled_at = ${now}
      WHERE id = ? AND cancelled_at IS NULL AND redeemed_at IS NULL AND EXISTS (SELECT 1 ${liveOwner})
      RETURNING id`).bind(id, await ownerSessionHash(ownerToken)).first<{ id: string }>();
    if (!row) throw new InvitationUnavailable();
  }
}
