import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
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
  const reader = request.body.getReader();
  const bytes = new Uint8Array(bodyLimit);
  const deadline = performance.now() + bodyReadMs;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; cancel(); }, bodyReadMs);
  let length = 0;
  try {
    // Bound the read count as well as bytes so empty chunks cannot starve the timer.
    for (let reads = 0; reads < 256; reads++) {
      const { done, value } = await reader.read();
      if (timedOut || performance.now() >= deadline) break;
      if (done) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      if (value.length > bytes.length - length) break;
      bytes.set(value, length);
      length += value.length;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (!timedOut) cancel();
    reader.releaseLock();
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

// Unwired: no Worker route, preview admission or session issuance. Callers
// must dispatch to a credential-free URL and pass the token only in the body.
export async function inviteAcceptance(request: Request, step: InviteStep, env: InviteEnv, registration: InviteRegistration): Promise<Response> {
  const origin = authOrigin(env.DRIVE_ORIGIN);
  if (!origin || !env.DB) return deny(503);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
  if (!allowsOrigin(request, origin.origin) || /[?#]/.test(request.url)) return deny(403);

  const input = await readInput(request);
  if (!record(input) || typeof input.token !== 'string' || !opaqueValue.test(input.token) ||
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
    return deny(step === 'present' && error instanceof InvitationUnavailable ? 404 : 503);
  }
}
