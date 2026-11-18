interface Statement {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface Database { prepare(sql: string): Statement }

export type ChallengePurpose = 'registration' | 'authentication';
export class CeremonyCapacityReached extends Error {}
export class ChallengeUnavailable extends Error {}

const lifetimeMs = 5 * 60 * 1000;
const capacity = 1024;
const authenticationCapacity = 512; // Reserve the remaining slots for registration.

// Context must be a stable server-authenticated principal or pre-authentication
// transaction identifier, never a request parameter or unverified identity.
export class BoundChallenges {
  constructor(private readonly db: Database) {}

  async issue(context: string, purpose: ChallengePurpose, expectedChallenge?: string): Promise<string> {
    this.validate(context, purpose);
    if (expectedChallenge !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(expectedChallenge)) throw new TypeError('Invalid challenge');
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const challenge = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    await this.db.prepare(`DELETE FROM drive_bound_ceremonies
      WHERE expires_at <= CAST(unixepoch('subsec') * 1000 AS INTEGER)`).run();
    // A stale replacement returns the unchanged challenge; capacity refusal returns no row.
    const row = await this.db.prepare(`INSERT INTO drive_bound_ceremonies (context, purpose, challenge, expires_at)
      SELECT ?1, ?2, ?3, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?4
      WHERE ((SELECT count(*) FROM drive_bound_ceremonies) < ?5 AND
        (?2 = 'registration' OR (SELECT count(*) FROM drive_bound_ceremonies WHERE purpose = 'authentication') < ?6))
        OR EXISTS (SELECT 1 FROM drive_bound_ceremonies WHERE context = ?1 AND purpose = ?2)
      ON CONFLICT (context, purpose) DO UPDATE SET
        challenge = CASE WHEN ?7 IN ('', drive_bound_ceremonies.challenge) THEN excluded.challenge ELSE drive_bound_ceremonies.challenge END,
        expires_at = CASE WHEN ?7 IN ('', drive_bound_ceremonies.challenge) THEN excluded.expires_at ELSE drive_bound_ceremonies.expires_at END
      RETURNING challenge`).bind(context, purpose, challenge, lifetimeMs, capacity, authenticationCapacity, expectedChallenge ?? '')
      .first<{ challenge: string }>();
    if (!row) throw new CeremonyCapacityReached('Ceremony capacity reached');
    if (row.challenge !== challenge) throw new ChallengeUnavailable('Challenge unavailable');
    return challenge;
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
    if (!row) throw new ChallengeUnavailable('Challenge unavailable');
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
