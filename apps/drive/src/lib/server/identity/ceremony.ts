import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';

// Configuration must come from trusted server configuration, never a request.
// This adapter does not consume challenges or bind credentials to principals.
export function createCeremonyVerifier(rpID: string, origin: string) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin ||
      parsed.hostname !== rpID || parsed.username || parsed.password) {
    throw new TypeError('Invalid WebAuthn relying party configuration');
  }

  return Object.freeze({
    registration(response: RegistrationResponseJSON, expectedChallenge: string) {
      return verifyRegistrationResponse({
        response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
        requireUserVerification: true,
      });
    },
    authentication(response: AuthenticationResponseJSON, expectedChallenge: string, credential: WebAuthnCredential) {
      return verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
        credential, requireUserVerification: true,
      });
    },
  });
}
