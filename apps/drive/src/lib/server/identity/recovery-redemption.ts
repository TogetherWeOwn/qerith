import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { createCeremonyVerifier } from './ceremony';

interface Statement {
  bind(...values: (string | number | number[])[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ meta: { changes: number }; results?: { expires_at: number }[] }[]>;
}

// Recovery replaces every existing credential, invalidates all old sessions and
// recovery tokens, and issues one new session. No HTTP endpoint is exposed here.
export class RecoveryRedemption {
  readonly #verifier: ReturnType<typeof createCeremonyVerifier>;
  constructor(private readonly db: Database, rpID: string, origin: string) {
    this.#verifier = createCeremonyVerifier(rpID, origin);
  }

  async redeem(token: string, challenge: string, response: RegistrationResponseJSON): Promise<{ token: string; expiresAt: number }> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new Error('Recovery unavailable');
    const result = await this.#verifier.registration(response, challenge);
    if (!result.verified || !result.registrationInfo) throw new Error('Registration not verified');
    const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
      byte => byte.toString(16).padStart(2, '0')).join('');
    const recoveryHash = await digest(token);
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const sessionToken = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const sessionHash = await digest(sessionToken);
    const context = `recovery:${recoveryHash}`;
    const credential = result.registrationInfo.credential;
    // The session is a transaction-local success marker. Every later statement
    // also checks the live token and exact challenge until the final redemption.
    const eligible = `SELECT t.principal_id FROM drive_recovery_tokens t
      JOIN drive_principals p ON p.id = t.principal_id
      JOIN drive_login_generations g ON g.principal_id = p.id
      JOIN drive_bound_ceremonies c ON c.context = ? AND c.purpose = 'registration' AND c.challenge = ?
      WHERE t.token_hash = ? AND t.cancelled_at IS NULL AND t.redeemed_at IS NULL
        AND t.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
        AND c.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER) AND p.status = 'active'`;
    const bound = [context, challenge, recoveryHash] as const;
    // Use the session's insertion time for the rest of the batch: wall-clock
    // expiry between statements must not leave a partially committed recovery.
    const target = `SELECT s.principal_id FROM drive_sessions s
      JOIN drive_recovery_tokens t ON t.principal_id = s.principal_id
      JOIN drive_principals p ON p.id = s.principal_id
      JOIN drive_login_generations g ON g.principal_id = p.id
      JOIN drive_bound_ceremonies c ON c.context = ? AND c.purpose = 'registration' AND c.challenge = ?
      WHERE s.token_hash = ? AND t.token_hash = ? AND t.cancelled_at IS NULL AND t.redeemed_at IS NULL
        AND t.expires_at > s.expires_at - 43200000 AND c.expires_at > s.expires_at - 43200000 AND p.status = 'active'`;
    const marker = [context, challenge, sessionHash, recoveryHash] as const;
    const batch = await this.db.batch([
      this.db.prepare(`INSERT INTO drive_sessions (token_hash, principal_id, expires_at)
        SELECT ?, principal_id, CAST(unixepoch('subsec') * 1000 AS INTEGER) + 43200000 FROM (${eligible}) RETURNING expires_at`)
        .bind(sessionHash, ...bound),
      this.db.prepare(`DELETE FROM drive_credentials WHERE principal_id IN (${target})`).bind(...marker),
      this.db.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports)
        SELECT ?, principal_id, ?, ?, ? FROM (${target})`)
        .bind(credential.id, Array.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), ...marker),
      this.db.prepare(`DELETE FROM drive_sessions WHERE token_hash != ? AND principal_id IN (${target})`)
        .bind(sessionHash, ...marker),
      this.db.prepare(`UPDATE drive_login_generations SET generation = lower(hex(randomblob(32))) WHERE principal_id IN (${target})`)
        .bind(...marker),
      this.db.prepare(`DELETE FROM drive_bound_ceremonies WHERE purpose = 'authentication' AND EXISTS (${target})`)
        .bind(...marker),
      this.db.prepare(`UPDATE drive_recovery_tokens SET cancelled_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
        WHERE token_hash != ? AND cancelled_at IS NULL AND redeemed_at IS NULL
          AND (principal_id IN (${target}) OR EXISTS (SELECT 1 FROM drive_principals
            WHERE role = 'owner' AND id IN (${target})))`)
        .bind(recoveryHash, ...marker, ...marker),
      this.db.prepare(`UPDATE drive_recovery_tokens SET redeemed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
        WHERE token_hash = ? AND principal_id IN (${target})`).bind(recoveryHash, ...marker),
    ]);
    // D1 includes the challenge-cleanup trigger in the final change count.
    if (batch[0].meta.changes !== 1 || batch[2].meta.changes !== 1 || batch[4].meta.changes !== 1 || batch[7].meta.changes < 1) {
      throw new Error('Recovery unavailable');
    }
    const session = batch[0].results?.[0];
    if (!session) throw new Error('Recovery unavailable');
    return { token: sessionToken, expiresAt: session.expires_at };
  }
}
