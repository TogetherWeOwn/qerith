import {
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';

function requireSameOrigin(encoded: string): void {
  const data = JSON.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')));
  if ((data.crossOrigin !== undefined && data.crossOrigin !== false) || data.topOrigin !== undefined) {
    throw new Error('Cross-origin WebAuthn ceremonies are not supported');
  }
}

// Configuration must come from trusted server configuration, never a request.
// This adapter does not consume challenges or bind credentials to principals.
export function createCeremonyVerifier(rpID: string, origin: string) {
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin ||
      parsed.hostname !== rpID || parsed.username || parsed.password) {
    throw new TypeError('Invalid WebAuthn relying party configuration');
  }

  return Object.freeze({
    async registration(response: RegistrationResponseJSON, expectedChallenge: string) {
      requireSameOrigin(response.response.clientDataJSON);
      return verifyRegistrationResponse({
        response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
        requireUserVerification: true,
      });
    },
    async authentication(response: AuthenticationResponseJSON, expectedChallenge: string, credential: WebAuthnCredential) {
      requireSameOrigin(response.response.clientDataJSON);
      if (response.id !== credential.id) throw new Error('Credential ID mismatch');
      return verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
        credential, requireUserVerification: true,
      });
    },
  });
}
