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

const context = 'owner-bootstrap';

// Server-only primitive: both methods require an independently authorized caller.
// It is not a provisioning endpoint or an authorization mechanism.
export class OwnerBootstrap {
  readonly #verifier: ReturnType<typeof createCeremonyVerifier>;
  constructor(private readonly db: Database, rpID: string, origin: string) {
    this.#verifier = createCeremonyVerifier(rpID, origin);
  }

  async issueChallenge(): Promise<string> {
    const owner = await this.db.prepare("SELECT id FROM drive_principals WHERE role = 'owner'").first();
    if (owner) throw new Error('Owner already exists');
    return new BoundChallenges(this.db).issue(context, 'registration');
  }

  async enroll(challenge: string, response: RegistrationResponseJSON): Promise<string> {
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new TypeError('Invalid challenge');
    const result = await this.#verifier.registration(response, challenge);
    if (!result.verified || !result.registrationInfo) throw new Error('Registration not verified');
    const credential = result.registrationInfo.credential;
    const principal = crypto.randomUUID();
    const batch = await this.db.batch([
      this.db.prepare(`INSERT INTO drive_principals (id, role, status)
        SELECT ?, 'owner', 'active' WHERE NOT EXISTS (SELECT 1 FROM drive_principals WHERE role = 'owner')
        AND EXISTS (SELECT 1 FROM drive_bound_ceremonies WHERE context = ? AND purpose = 'registration'
          AND challenge = ? AND expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER))`)
        .bind(principal, context, challenge),
      this.db.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports)
        SELECT ?, id, ?, ?, ? FROM drive_principals WHERE id = ?`)
        .bind(credential.id, Array.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), principal),
      this.db.prepare(`DELETE FROM drive_bound_ceremonies WHERE context = ? AND purpose = 'registration' AND challenge = ?
        AND EXISTS (SELECT 1 FROM drive_principals WHERE id = ?)`)
        .bind(context, challenge, principal),
    ]);
    if (batch[1].meta.changes !== 1) throw new Error('Owner or challenge unavailable');
    return principal;
  }
}
