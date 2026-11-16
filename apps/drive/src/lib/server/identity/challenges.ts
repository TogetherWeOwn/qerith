interface Statement {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface Database { prepare(sql: string): Statement }

export type ChallengePurpose = 'registration' | 'authentication';

const lifetimeMs = 5 * 60 * 1000;
const capacity = 1024;

// Context must be a stable server-authenticated principal or pre-authentication
// transaction identifier, never a request parameter or unverified identity.
export class BoundChallenges {
  constructor(private readonly db: Database) {}

  async issue(context: string, purpose: ChallengePurpose): Promise<string> {
    this.validate(context, purpose);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const challenge = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    await this.db.prepare(`DELETE FROM drive_bound_ceremonies
      WHERE expires_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)`).run();
    const inserted = await this.db.prepare(`INSERT INTO drive_bound_ceremonies (context, purpose, challenge, expires_at)
      SELECT ?, ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?
      WHERE (SELECT count(*) FROM drive_bound_ceremonies) < ?
        OR EXISTS (SELECT 1 FROM drive_bound_ceremonies WHERE context = ? AND purpose = ?)
      ON CONFLICT (context, purpose) DO UPDATE SET challenge = excluded.challenge, expires_at = excluded.expires_at
      RETURNING challenge`).bind(context, purpose, challenge, lifetimeMs, capacity, context, purpose).first<{ challenge: string }>();
    if (!inserted) throw new Error('Ceremony capacity reached');
    return inserted.challenge;
  }

  private validate(context: string, purpose: ChallengePurpose): void {
    if (typeof context !== 'string' || context.length < 1 || context.length > 256 ||
        (purpose !== 'registration' && purpose !== 'authentication')) throw new TypeError('Invalid ceremony context');
  }

  async consume(context: string, purpose: ChallengePurpose, challenge: string): Promise<void> {
    this.validate(context, purpose);
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new TypeError('Invalid challenge');
    const row = await this.db.prepare(`DELETE FROM drive_bound_ceremonies
      WHERE context = ? AND purpose = ? AND challenge = ?
        AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      RETURNING challenge`).bind(context, purpose, challenge).first<{ challenge: string }>();
    if (!row) throw new Error('Challenge unavailable');
  }
}

// This is persistence only, not authentication or ceremony verification.
export class WebAuthnChallenges {
  constructor(private readonly db: Database) {}

  async issue(challenge: string, purpose: ChallengePurpose, expiresAt: number): Promise<void> {
    if (typeof challenge !== 'string' || challenge.length === 0 ||
        (purpose !== 'registration' && purpose !== 'authentication') ||
        !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      throw new TypeError('Invalid challenge');
    }
    await this.db.prepare(`INSERT INTO drive_webauthn_challenges (challenge, purpose, expires_at)
      VALUES (?, ?, ?)`).bind(challenge, purpose, expiresAt).run();
  }

  // Consume before verification. A failed verification or ambiguous database error
  // requires a new challenge; never restore a consumed challenge for retry.
  async consume(challenge: string, purpose: ChallengePurpose): Promise<boolean> {
    const row = await this.db.prepare(`UPDATE drive_webauthn_challenges SET consumed = 1
      WHERE challenge = ? AND purpose = ? AND consumed = 0
        AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
      RETURNING challenge`).bind(challenge, purpose).first<{ challenge: string }>();
    return row !== null;
  }
}
