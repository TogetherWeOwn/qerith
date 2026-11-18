import type { AuthenticationResponseJSON, WebAuthnCredential } from '@simplewebauthn/server';
import { BoundChallenges, ChallengeUnavailable } from './challenges';
import { createCeremonyVerifier } from './ceremony';
import { tokenHash } from './sessions';

interface Statement {
  bind(...values: (string | number | number[])[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}
interface CredentialRow {
  id: string;
  principal_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string;
  generation: string;
  status: 'active' | 'revoked';
}

export class PasskeyDenied extends Error {}
export class RevokedPasskey extends Error {}

// Context is a trusted server-side pre-authentication transaction, not an identity
// or request parameter. This service exposes no HTTP endpoint or cookie policy.
export class PasskeyLogin {
  readonly #verifier: ReturnType<typeof createCeremonyVerifier>;
  constructor(private readonly db: Database, rpID: string, origin: string) {
    this.#verifier = createCeremonyVerifier(rpID, origin);
  }

  async issueChallenge(context: string, previous?: { context: string; challenge: string }): Promise<string> {
    const challenges = new BoundChallenges(this.db);
    if (previous) {
      await challenges.consume(previous.context, 'authentication', previous.challenge).catch(error => {
        if (!(error instanceof ChallengeUnavailable)) throw error;
      });
    }
    return challenges.issue(context, 'authentication');
  }

  async authenticate(context: string, challenge: string, response: AuthenticationResponseJSON | null): Promise<{ token: string; expiresAt: number }> {
    // Snapshot membership before consuming so revocation during login cannot be missed.
    let row: CredentialRow | null = null;
    try {
      if (response) {
        row = await this.db.prepare(`SELECT c.id, c.principal_id, c.public_key, c.counter, c.transports, g.generation, p.status
          FROM drive_credentials c JOIN drive_principals p ON p.id = c.principal_id
          JOIN drive_login_generations g ON g.principal_id = p.id
          WHERE c.id = ?`).bind(response.id).first<CredentialRow>();
      }
    } finally {
      // Even an invalid assertion or an ambiguous write needs a new challenge.
      await new BoundChallenges(this.db).consume(context, 'authentication', challenge);
    }
    if (!row || !response) throw new PasskeyDenied('Authentication unavailable');
    const credential: WebAuthnCredential = {
      id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter,
      transports: JSON.parse(row.transports) as WebAuthnCredential['transports'],
    };
    const result = await this.#verifier.authentication(response, challenge, credential).catch(() => {
      throw new PasskeyDenied('Authentication not verified');
    });
    if (!result.verified || !result.authenticationInfo) throw new PasskeyDenied('Authentication not verified');
    // Reveal revoked membership only to a holder who proved possession. Never
    // attempt a session write for a snapshot that was already revoked.
    if (row.status === 'revoked') throw new RevokedPasskey('Access revoked');
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const hash = await tokenHash(token);
    const key = Array.from(new Uint8Array(row.public_key));
    const batch = await this.db.batch([
      this.db.prepare(`INSERT INTO drive_sessions (token_hash, principal_id, expires_at)
        SELECT ?, c.principal_id, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?
        FROM drive_credentials c JOIN drive_principals p ON p.id = c.principal_id
        JOIN drive_login_generations g ON g.principal_id = p.id
        WHERE c.id = ? AND c.principal_id = ? AND c.public_key = ? AND c.counter = ?
          AND p.status = 'active' AND g.generation = ?`)
        .bind(hash, 12 * 60 * 60 * 1000, row.id, row.principal_id, key, row.counter, row.generation),
      this.db.prepare(`UPDATE drive_credentials SET counter = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM drive_sessions WHERE token_hash = ?)`)
        .bind(result.authenticationInfo.newCounter, row.id, hash),
    ]);
    if (batch[0].meta.changes === 0 && batch[1].meta.changes === 0) throw new PasskeyDenied('Authentication unavailable');
    if (batch[0].meta.changes !== 1 || batch[1].meta.changes !== 1) throw new Error('Authentication unavailable');
    const session = await this.db.prepare('SELECT expires_at FROM drive_sessions WHERE token_hash = ?').bind(hash).first<{ expires_at: number }>();
    if (!session) throw new Error('Authentication unavailable');
    return { token, expiresAt: session.expires_at };
  }
}
