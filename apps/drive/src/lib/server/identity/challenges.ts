interface Statement {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface Database { prepare(sql: string): Statement }

export type ChallengePurpose = 'registration' | 'authentication';

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
