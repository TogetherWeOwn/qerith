import { generateRegistrationOptions } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { createCeremonyVerifier } from './ceremony';

interface Statement {
  bind(...values: (string | number | number[])[]): Statement;
  first<T>(): Promise<T | null>;
}
interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<{ meta: { changes: number } }[]>;
}

const lifetimeMs = 5 * 60 * 1000;

// Server-only primitive: both methods require an independently authorized caller.
// It is not a provisioning endpoint or an authorization mechanism.
export class OwnerBootstrap {
  readonly #verifier: ReturnType<typeof createCeremonyVerifier>;
  constructor(private readonly db: Database, private readonly rpID: string, origin: string) {
    this.#verifier = createCeremonyVerifier(rpID, origin);
  }

  async issueOptions() {
    const principal = crypto.randomUUID();
    const options = await generateRegistrationOptions({
      rpID: this.rpID, rpName: 'Drive', userName: 'Drive owner',
      userID: crypto.getRandomValues(new Uint8Array(32)), timeout: lifetimeMs,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const issued = await this.db.prepare(`INSERT INTO drive_owner_registration
      (singleton, challenge, principal_id, webauthn_user_handle, expires_at)
      SELECT 1, ?, ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?
      WHERE NOT EXISTS (SELECT 1 FROM drive_principals WHERE role = 'owner')
      ON CONFLICT (singleton) DO UPDATE SET challenge = excluded.challenge,
        principal_id = excluded.principal_id, webauthn_user_handle = excluded.webauthn_user_handle,
        expires_at = excluded.expires_at
      RETURNING challenge`).bind(options.challenge, principal, options.user.id, lifetimeMs).first();
    if (!issued) throw new Error('Owner already exists');
    return options;
  }

  async enroll(challenge: string, response: RegistrationResponseJSON): Promise<void> {
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new TypeError('Invalid challenge');
    const result = await this.#verifier.registration(response, challenge);
    if (!result.verified || !result.registrationInfo) throw new Error('Registration not verified');
    const credential = result.registrationInfo.credential;
    // These statements share a transaction. Each dependent write requires the
    // preceding write to succeed; uniqueness errors roll back the entire batch.
    const batch = await this.db.batch([
      this.db.prepare(`INSERT INTO drive_principals (id, role, status, webauthn_user_handle)
        SELECT principal_id, 'owner', 'active', webauthn_user_handle FROM drive_owner_registration
        WHERE singleton = 1 AND challenge = ? AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
          AND NOT EXISTS (SELECT 1 FROM drive_principals WHERE role = 'owner')`).bind(challenge),
      this.db.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
        SELECT ?, principal_id, ?, ?, ?, webauthn_user_handle FROM drive_owner_registration
        WHERE singleton = 1 AND challenge = ? AND changes() = 1`)
        .bind(credential.id, Array.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), challenge),
      this.db.prepare(`DELETE FROM drive_owner_registration
        WHERE singleton = 1 AND challenge = ? AND changes() = 1`).bind(challenge),
    ]);
    if (batch.some(({ meta }) => meta.changes !== 1)) throw new Error('Owner or challenge unavailable');
  }
}
