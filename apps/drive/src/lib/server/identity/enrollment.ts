import type { RegistrationResponseJSON } from '@simplewebauthn/server';
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

async function invitationHash(token: string): Promise<string> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new TypeError('Invalid invitation');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// The RP configuration is trusted server configuration; this service exposes no endpoint.
export class InvitationEnrollment {
  readonly #verifier: ReturnType<typeof createCeremonyVerifier>;
  constructor(private readonly db: Database, rpID: string, origin: string) {
    this.#verifier = createCeremonyVerifier(rpID, origin);
  }

  async issueChallenge(token: string): Promise<string> {
    const hash = await invitationHash(token);
    const invitation = await this.db.prepare(`SELECT id FROM drive_invitations WHERE token_hash = ?
      AND cancelled_at IS NULL AND redeemed_at IS NULL
      AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)`).bind(hash).first();
    if (!invitation) throw new Error('Invitation unavailable');
    return new BoundChallenges(this.db).issue(`invitation:${hash}`, 'registration');
  }

  async enroll(token: string, challenge: string, response: RegistrationResponseJSON): Promise<string> {
    const hash = await invitationHash(token);
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new TypeError('Invalid challenge');
    const result = await this.#verifier.registration(response, challenge);
    if (!result.verified || !result.registrationInfo) throw new Error('Registration not verified');
    const credential = result.registrationInfo.credential;
    const principal = crypto.randomUUID();
    const context = `invitation:${hash}`;
    const batch = await this.db.batch([
      this.db.prepare(`INSERT INTO drive_principals (id, role, status)
        SELECT ?, 'member', 'active' WHERE EXISTS (SELECT 1 FROM drive_invitations
          WHERE token_hash = ? AND cancelled_at IS NULL AND redeemed_at IS NULL
            AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER))
        AND EXISTS (SELECT 1 FROM drive_bound_ceremonies WHERE context = ? AND purpose = 'registration'
          AND challenge = ? AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER))`)
        .bind(principal, hash, context, challenge),
      this.db.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports)
        SELECT ?, id, ?, ?, ? FROM drive_principals WHERE id = ?`)
        .bind(credential.id, Array.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), principal),
      this.db.prepare(`UPDATE drive_invitations SET redeemed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
        WHERE token_hash = ? AND EXISTS (SELECT 1 FROM drive_principals WHERE id = ?)`)
        .bind(hash, principal),
      this.db.prepare(`DELETE FROM drive_bound_ceremonies WHERE context = ? AND purpose = 'registration' AND challenge = ?
        AND EXISTS (SELECT 1 FROM drive_principals WHERE id = ?)`)
        .bind(context, challenge, principal),
    ]);
    if (batch[0].meta.changes !== 1) throw new Error('Invitation or challenge unavailable');
    return principal;
  }
}
