import type { AuthenticationResponseJSON, WebAuthnCredential } from '@simplewebauthn/server';
import { BoundChallenges } from './challenges';
import { createCeremonyVerifier } from './ceremony';

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
}

// Context is a trusted server-side pre-authentication transaction, not an identity
// or request parameter. This service exposes no HTTP endpoint or cookie policy.
export class PasskeyLogin {
  readonly #verifier: ReturnType<typeof createCeremonyVerifier>;
  constructor(private readonly db: Database, rpID: string, origin: string) {
    this.#verifier = createCeremonyVerifier(rpID, origin);
  }

  issueChallenge(context: string): Promise<string> {
    return new BoundChallenges(this.db).issue(context, 'authentication');
  }

  async authenticate(context: string, challenge: string, response: AuthenticationResponseJSON): Promise<{ token: string; expiresAt: number }> {
    // Consume first: even an invalid assertion or an ambiguous write needs a new challenge.
    await new BoundChallenges(this.db).consume(context, 'authentication', challenge);
    const row = await this.db.prepare(`SELECT c.id, c.principal_id, c.public_key, c.counter, c.transports
      FROM drive_credentials c JOIN drive_principals p ON p.id = c.principal_id
      WHERE c.id = ? AND p.status = 'active'`).bind(response.id).first<CredentialRow>();
    if (!row) throw new Error('Authentication unavailable');
    const result = await this.#verifier.authentication(response, challenge, {
      id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter,
      transports: JSON.parse(row.transports) as WebAuthnCredential['transports'],
    });
    if (!result.verified || !result.authenticationInfo) throw new Error('Authentication not verified');
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const key = Array.from(new Uint8Array(row.public_key));
    const batch = await this.db.batch([
      this.db.prepare(`INSERT INTO drive_sessions (token_hash, principal_id, expires_at)
        SELECT ?, c.principal_id, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?
        FROM drive_credentials c JOIN drive_principals p ON p.id = c.principal_id
        WHERE c.id = ? AND c.principal_id = ? AND c.public_key = ? AND c.counter = ? AND p.status = 'active'`)
        .bind(hash, 12 * 60 * 60 * 1000, row.id, row.principal_id, key, row.counter),
      this.db.prepare(`UPDATE drive_credentials SET counter = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM drive_sessions WHERE token_hash = ?)`)
        .bind(result.authenticationInfo.newCounter, row.id, hash),
    ]);
    if (batch[0].meta.changes !== 1 || batch[1].meta.changes !== 1) throw new Error('Authentication unavailable');
    const session = await this.db.prepare('SELECT expires_at FROM drive_sessions WHERE token_hash = ?').bind(hash).first<{ expires_at: number }>();
    if (!session) throw new Error('Authentication unavailable');
    return { token, expiresAt: session.expires_at };
  }
}
