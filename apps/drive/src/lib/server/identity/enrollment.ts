import { generateRegistrationOptions, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { BoundChallenges } from './challenges';
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

export class InvitationEnrollmentDenied extends Error {}

const opaqueValue = /^[A-Za-z0-9_-]{43}$/;
const now = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const liveInvite = `token_hash = ? AND cancelled_at IS NULL AND redeemed_at IS NULL AND expires_at > ${now}`;
const liveChallenge = `context = ? AND purpose = 'registration' AND challenge = ? AND expires_at > ${now}`;

async function invitationHash(token: string): Promise<string> {
  if (typeof token !== 'string' || !opaqueValue.test(token)) throw new InvitationEnrollmentDenied('Invitation unavailable');
  return tokenHash(token);
}

async function userHandle(invitationId: string) {
  // Keep the discoverable account stable across challenge retries without using
  // the bearer token, its lookup hash, or any caller-provided identity as user.id.
  const input = new TextEncoder().encode(`drive:invite-user:${invitationId}`);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

// The RP configuration is trusted server configuration; this service exposes no endpoint.
export class InvitationEnrollment {
  readonly #verifier: ReturnType<typeof createCeremonyVerifier>;
  constructor(private readonly db: Database, private readonly rpID: string, origin: string) {
    this.#verifier = createCeremonyVerifier(rpID, origin);
  }

  async issueOptions(token: string) {
    const hash = await invitationHash(token);
    const invitation = await this.db.prepare(`SELECT id FROM drive_invitations WHERE ${liveInvite}`)
      .bind(hash).first<{ id: string }>();
    if (!invitation) throw new InvitationEnrollmentDenied('Invitation unavailable');
    const challenge = await new BoundChallenges(this.db).issue(`invitation:${hash}`, 'registration');
    return generateRegistrationOptions({
      rpID: this.rpID, rpName: 'Drive', userName: 'Drive member',
      userID: await userHandle(invitation.id), challenge: isoBase64URL.toBuffer(challenge), timeout: 300_000,
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
  }

  async enroll(token: string, challenge: string, response: RegistrationResponseJSON): Promise<string> {
    const hash = await invitationHash(token);
    if (typeof challenge !== 'string' || !opaqueValue.test(challenge)) throw new InvitationEnrollmentDenied('Invalid challenge');
    const context = `invitation:${hash}`;
    // Reject stale or unrelated ceremonies before verifying untrusted attestation.
    const invitation = await this.db.prepare(`SELECT id FROM drive_invitations WHERE ${liveInvite}
      AND EXISTS (SELECT 1 FROM drive_bound_ceremonies WHERE ${liveChallenge})`)
      .bind(hash, context, challenge).first<{ id: string }>();
    if (!invitation) throw new InvitationEnrollmentDenied('Invitation or challenge unavailable');
    const result = await this.#verifier.registration(response, challenge).catch(() => null);
    if (!result?.verified || !result.registrationInfo) throw new InvitationEnrollmentDenied('Registration not verified');
    const credential = result.registrationInfo.credential;
    const principal = crypto.randomUUID();
    const handle = isoBase64URL.fromBuffer(await userHandle(invitation.id));
    // The atomic write rechecks authorization after verification.
    const batch = await this.db.batch([
      this.db.prepare(`INSERT INTO drive_principals (id, role, status, webauthn_user_handle)
        SELECT ?, 'member', 'active', ? WHERE EXISTS (SELECT 1 FROM drive_invitations WHERE ${liveInvite} AND id = ?)
        AND EXISTS (SELECT 1 FROM drive_bound_ceremonies WHERE ${liveChallenge})`)
        .bind(principal, handle, hash, invitation.id, context, challenge),
      this.db.prepare(`INSERT INTO drive_credentials (id, principal_id, public_key, counter, transports, webauthn_user_handle)
        SELECT ?, id, ?, ?, ?, webauthn_user_handle FROM drive_principals WHERE id = ?`)
        .bind(credential.id, Array.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports ?? []), principal),
      this.db.prepare(`UPDATE drive_invitations SET redeemed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
        WHERE token_hash = ? AND EXISTS (SELECT 1 FROM drive_principals WHERE id = ?)`)
        .bind(hash, principal),
      this.db.prepare(`DELETE FROM drive_bound_ceremonies WHERE context = ? AND purpose = 'registration' AND challenge = ?
        AND EXISTS (SELECT 1 FROM drive_principals WHERE id = ?)`)
        .bind(context, challenge, principal),
    ]);
    if (batch[1].meta.changes !== 1) throw new InvitationEnrollmentDenied('Invitation or challenge unavailable');
    return principal;
  }
}
