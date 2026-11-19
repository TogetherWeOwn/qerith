import { generateRegistrationOptions } from '@simplewebauthn/server';
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
  batch(statements: Statement[]): Promise<{ results?: { principal_id: string }[] }[]>;
}

async function invitationHash(token: string): Promise<string> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new TypeError('Invalid invitation');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// The RP configuration is trusted server configuration; this service exposes no endpoint.
export class InvitationEnrollment {
  readonly #verifier: ReturnType<typeof createCeremonyVerifier>;
  constructor(private readonly db: Database, private readonly rpID: string, origin: string) {
    this.#verifier = createCeremonyVerifier(rpID, origin);
  }

  async issueOptions(token: string) {
    const hash = await invitationHash(token);
    const invitation = await this.db.prepare(`SELECT id FROM drive_invitations WHERE token_hash = ?
      AND cancelled_at IS NULL AND redeemed_at IS NULL
      AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)`).bind(hash).first();
    if (!invitation) throw new Error('Invitation unavailable');
    const principalId = crypto.randomUUID();
    const options = await generateRegistrationOptions({
      rpID: this.rpID, rpName: 'Drive', userName: 'Drive member',
      userID: crypto.getRandomValues(new Uint8Array(32)),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    await new BoundChallenges(this.db).issueRegistration(`invitation:${hash}`, options.challenge, principalId, options.user.id);
    return options;
  }

  async enroll(token: string, challenge: string, response: RegistrationResponseJSON): Promise<string> {
    const hash = await invitationHash(token);
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new TypeError('Invalid challenge');
    const result = await this.#verifier.registration(response, challenge);
    if (!result.verified || !result.registrationInfo) throw new Error('Registration not verified');
    const credential = result.registrationInfo.credential;
    const context = `invitation:${hash}`;
    // Read identity only from the matching server-owned ceremony. Dependent
    // writes run in the same transaction; uniqueness failures roll them back.
    const batch = await this.db.batch([
      this.db.prepare(`INSERT INTO drive_principals (id, role, status, webauthn_user_handle)
        SELECT principal_id, 'member', 'active', webauthn_user_handle FROM drive_bound_ceremonies
        WHERE context = ? AND purpose = 'registration' AND challenge = ?
          AND principal_id IS NOT NULL AND webauthn_user_handle IS NOT NULL
          AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND EXISTS (SELECT 1 FROM drive_invitations
            WHERE token_hash = ? AND cancelled_at IS NULL AND redeemed_at IS NULL
              AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER))`).bind(context, challenge, hash),
      this.db.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
        SELECT ?, principal_id, ?, ?, ?, webauthn_user_handle FROM drive_bound_ceremonies
        WHERE context = ? AND purpose = 'registration' AND challenge = ? AND changes() = 1`)
        .bind(credential.id, Array.from(credential.publicKey), credential.counter,
          JSON.stringify(credential.transports ?? []), context, challenge),
      this.db.prepare(`UPDATE drive_invitations SET redeemed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
        WHERE token_hash = ? AND changes() = 1`).bind(hash),
      this.db.prepare(`DELETE FROM drive_bound_ceremonies
        WHERE context = ? AND purpose = 'registration' AND challenge = ? AND changes() = 1
        RETURNING principal_id`).bind(context, challenge),
    ]);
    const enrolled = batch[3].results?.[0];
    if (!enrolled) throw new Error('Invitation or challenge unavailable');
    return enrolled.principal_id;
  }
}
