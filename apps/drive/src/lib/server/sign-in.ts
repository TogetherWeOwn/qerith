import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { decodeClientDataJSON, isoBase64URL } from '@simplewebauthn/server/helpers';
import { readBoundedBody } from './bounded-io';
import { CeremonyCapacityReached, ChallengeUnavailable } from './identity/challenges';
import { PasskeyDenied, PasskeyLogin, RevokedPasskey } from './identity/login';
import { admitsStagingInvite, allowsOrigin, authOrigin, readOpaqueCookie, sessionCookie, stagingOrigin, type DriveAuthEnv } from './request-auth';

const transactionCookie = '__Host-drive-login';
const transactionPattern = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/;
const assertionLimit = 16 * 1024;
const assertionReadMs = 2_000;
const base64url = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);

function hostCookie(name: string, value: string, maxAge: number, sameSite: 'Strict' | 'Lax'): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}`;
}

async function readAssertion(request: Request, challenge: string): Promise<AuthenticationResponseJSON | null> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' ||
      !request.body || request.body.locked) return null;
  try {
    const bytes = await readBoundedBody(request.body, {
      maxBytes: assertionLimit, timeoutMs: assertionReadMs, signal: request.signal,
    });
    if (!bytes || request.signal.aborted) return null;
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (data?.type !== 'public-key' || !base64url(data.id) || data.rawId !== data.id ||
        !base64url(data.response?.clientDataJSON) || !base64url(data.response.authenticatorData) ||
        !base64url(data.response.signature) ||
        (data.response.userHandle !== undefined && !base64url(data.response.userHandle))) return null;
    const { clientDataJSON, authenticatorData, signature, userHandle } = data.response;
    // Correlate before spending the challenge; the verifier still checks signed client data.
    if (decodeClientDataJSON(clientDataJSON).challenge !== challenge) return null;
    return {
      id: data.id, rawId: data.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON, authenticatorData, signature, userHandle },
    };
  } catch {
    return null;
  }
}

export async function signIn(
  request: Request,
  step: 'challenge' | 'restart' | 'verify',
  env: DriveAuthEnv & { DB?: ConstructorParameters<typeof PasskeyLogin>[0] },
): Promise<Response> {
  const headers = new Headers({ 'cache-control': 'private, no-store' });
  const reply = (status: number, code: string) => Response.json({ code }, { status, headers });
  const origin = authOrigin(env.DRIVE_ORIGIN);
  if (!origin || !env.DB) return reply(503, 'unavailable');
  if (!allowsOrigin(request, origin.origin)) return reply(403, 'forbidden');
  if (request.method !== 'POST') {
    headers.set('allow', 'POST');
    return reply(405, 'method');
  }

  try {
    const ownerOnly = origin.origin === stagingOrigin && !admitsStagingInvite(env);
    const login = new PasskeyLogin(env.DB, origin.hostname, origin.origin, ownerOnly);
    // A serialized restart after a lost response must leave the previous context alone.
    const transaction = step === 'restart' ? null : readOpaqueCookie(request, transactionCookie, transactionPattern);
    const [context, challenge] = transaction?.split('.') ?? [];
    if (step !== 'verify') {
      const nextContext = context ?? isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));
      const nextChallenge = await login.issueChallenge(nextContext, challenge);
      headers.append('set-cookie', hostCookie(transactionCookie, `${nextContext}.${nextChallenge}`, 300, 'Strict'));
      return Response.json({ challenge: nextChallenge, rpId: origin.hostname, userVerification: 'required', timeout: 300_000 }, { headers });
    }

    const assertion = challenge && await readAssertion(request, challenge);
    if (!assertion || request.signal.aborted) return reply(401, 'denied');
    // The database consumes the challenge; a delayed response must not clear a newer cookie.
    const session = await login.authenticate(context, challenge, assertion);
    const maxAge = Math.floor((session.expiresAt - Date.now()) / 1000);
    if (maxAge <= 0) return reply(503, 'unavailable');
    headers.append('set-cookie', hostCookie(sessionCookie, session.token, maxAge, 'Lax'));
    return new Response(null, { status: 204, headers });
  } catch (error) {
    if (error instanceof CeremonyCapacityReached) {
      headers.set('retry-after', '60');
      return reply(429, 'rate-limited');
    }
    if (step === 'challenge' && error instanceof ChallengeUnavailable) return reply(409, 'restart-required');
    if (error instanceof ChallengeUnavailable || error instanceof PasskeyDenied) return reply(401, 'denied');
    if (error instanceof RevokedPasskey) return reply(403, 'revoked');
    return reply(503, 'unavailable');
  }
}
