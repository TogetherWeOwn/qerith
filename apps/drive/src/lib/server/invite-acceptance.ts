import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { readBoundedBody } from './bounded-io';
import { CeremonyCapacityReached } from './identity/challenges';
import { InvitationEnrollment } from './identity/enrollment';
import { Invitations, InvitationUnavailable } from './identity/invitations';
import { Sessions } from './identity/sessions';
import { allowsOrigin, authOrigin, readOpaqueCookie, sessionCookie } from './request-auth';

// Expected denials return null/false; infrastructure faults throw. The service
// returns only public WebAuthn options and owns verification and atomic redemption.
export interface InviteRegistration {
  issueOptions(token: string): Promise<PublicKeyCredentialCreationOptionsJSON | null>;
  enroll(token: string, challenge: string, response: RegistrationResponseJSON): Promise<boolean>;
}

type InviteDatabase = ConstructorParameters<typeof Invitations>[0] & ConstructorParameters<typeof Sessions>[0];
type InviteEnv = { DRIVE_ORIGIN?: string; DB?: InviteDatabase };
type InviteStep = 'present' | 'challenge' | 'enroll';

const opaqueValue = /^[A-Za-z0-9_-]{43}$/;
const bodyLimit = 32 * 1024;
const bodyReadMs = 2_000;
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' };
const deny = (status: number) => new Response(null, { status, headers });

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const base64url = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

async function readInput(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' ||
      !request.body || request.body.locked) return null;
  try {
    const bytes = await readBoundedBody(request.body, {
      maxBytes: bodyLimit, maxReads: 256, timeoutMs: bodyReadMs, signal: request.signal,
    });
    return bytes && JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function readRegistration(value: unknown): RegistrationResponseJSON | null {
  if (!record(value) || value.type !== 'public-key' || !base64url(value.id) || value.rawId !== value.id ||
      !record(value.response)) return null;
  const { clientDataJSON, attestationObject } = value.response;
  if (!base64url(clientDataJSON) || !base64url(attestationObject)) return null;
  return {
    id: value.id, rawId: value.id, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON, attestationObject },
  };
}

// No Worker admission or session issuance. The caller must use a
// credential-free URL; the invitation token travels only in the body.
export function handleInviteAcceptance(request: Request, step: InviteStep,
  env: InviteEnv & { DB?: ConstructorParameters<typeof InvitationEnrollment>[0] }): Promise<Response> {
  const origin = authOrigin(env.DRIVE_ORIGIN);
  if (!origin || !env.DB) return Promise.resolve(deny(503));
  const enrollment = new InvitationEnrollment(env.DB, origin.hostname, origin.origin);
  return inviteAcceptance(request, step, env, {
    issueOptions: (token) => enrollment.issueOptions(token),
    async enroll(token, challenge, response) {
      await enrollment.enroll(token, challenge, response);
      return true;
    },
  });
}

export async function inviteAcceptance(request: Request, step: InviteStep, env: InviteEnv, registration: InviteRegistration): Promise<Response> {
  const origin = authOrigin(env.DRIVE_ORIGIN);
  if (!origin || !env.DB) return deny(503);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
  if (!allowsOrigin(request, origin.origin) || /[?#]/.test(request.url)) return deny(403);

  const input = await readInput(request);
  if (request.signal.aborted || !record(input) || typeof input.token !== 'string' || !opaqueValue.test(input.token) ||
      Object.keys(input).length !== (step === 'enroll' ? 3 : 1)) return deny(400);
  const { token, challenge } = input;
  const assertion = step === 'enroll' && base64url(challenge) ? readRegistration(input.response) : null;
  if (step === 'enroll' && !assertion) return deny(400);

  try {
    const cookie = request.headers.get('cookie');
    const session = readOpaqueCookie(request, sessionCookie, opaqueValue);
    // Do not mistake duplicate, malformed or joined session cookies for anonymity.
    if (cookie !== null && (/[^\t\x20-\x7e]|,/.test(cookie) || (session === null &&
        cookie.split(';').some((pair) => pair.split('=', 1)[0].trim() === sessionCookie)))) return deny(404);
    if (session !== null && await new Sessions(env.DB).lookup(session)) return deny(404);

    if (step === 'present') return Response.json(await new Invitations(env.DB).present(token), { headers });
    if (step === 'challenge') {
      const options = await registration.issueOptions(token);
      return options === null ? deny(404) : Response.json({ options }, { headers });
    }
    if (step === 'enroll' && typeof challenge === 'string' && assertion &&
        await registration.enroll(token, challenge, assertion)) return new Response(null, { status: 204, headers });
    return deny(404);
  } catch (error) {
    if (error instanceof InvitationUnavailable) return deny(404);
    if (error instanceof CeremonyCapacityReached) {
      return new Response(null, { status: 429, headers: { ...headers, 'retry-after': '60' } });
    }
    return deny(503);
  }
}
