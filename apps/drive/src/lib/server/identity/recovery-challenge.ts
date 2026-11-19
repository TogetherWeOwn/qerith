interface Statement {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface Database { prepare(sql: string): Statement }

// Preparation only: this does not verify registration or redeem a token.
export class RecoveryChallenges {
  constructor(private readonly db: Database) {}

  async issue(token: string): Promise<string> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Recovery unavailable');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const context = `recovery:${hash}`;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const challenge = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    await this.db.prepare(`DELETE FROM drive_bound_ceremonies
      WHERE expires_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)`).run();
    const row = await this.db.prepare(`INSERT INTO drive_bound_ceremonies (context, purpose, challenge, expires_at)
      SELECT ?, 'registration', ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) + 300000
      WHERE EXISTS (SELECT 1 FROM drive_recovery_tokens t JOIN drive_principals p ON p.id = t.principal_id
        WHERE t.token_hash = ? AND t.cancelled_at IS NULL AND t.redeemed_at IS NULL
          AND t.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER) AND p.status = 'active')
        AND ((SELECT count(*) FROM drive_bound_ceremonies) < 1024
          OR EXISTS (SELECT 1 FROM drive_bound_ceremonies WHERE context = ? AND purpose = 'registration'))
      ON CONFLICT (context, purpose) DO UPDATE SET challenge = excluded.challenge, expires_at = excluded.expires_at
      RETURNING challenge`).bind(context, challenge, hash, context).first<{ challenge: string }>();
    if (!row) throw new Error('Recovery unavailable');
    return row.challenge;
  }
}
