import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from '@simplewebauthn/server';
import { createCeremonyVerifier } from './ceremony';
import { BoundChallenges } from './challenges';
import type { ChallengePurpose } from './challenges';

interface Statement {
  bind(...values: (string | number)[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
interface Database { prepare(sql: string): Statement }

// Context is selected by trusted server code, never from a request, credential
// ID or unverified identity. The caller authorizes the operation and selects
// the credential separately; this class creates no session or enrollment.
export class BoundCeremonies {
  private readonly verifier: ReturnType<typeof createCeremonyVerifier>;
  private readonly challenges: BoundChallenges;

  constructor(db: Database, rpID: string, origin: string) {
    this.verifier = createCeremonyVerifier(rpID, origin);
    this.challenges = new BoundChallenges(db);
  }

  issue(context: string, purpose: ChallengePurpose): Promise<string> {
    return this.challenges.issue(context, purpose);
  }

  async registration(context: string, challenge: string, response: RegistrationResponseJSON) {
    await this.challenges.consume(context, 'registration', challenge);
    return this.verifier.registration(response, challenge);
  }

  async authentication(context: string, challenge: string, response: AuthenticationResponseJSON, credential: WebAuthnCredential) {
    await this.challenges.consume(context, 'authentication', challenge);
    return this.verifier.authentication(response, challenge, credential);
  }
}
