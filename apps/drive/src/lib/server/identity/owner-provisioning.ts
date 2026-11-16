import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { OwnerBootstrap } from './owner-bootstrap';

// This protocol is not an authorization boundary. Only a separately authenticated,
// deployer-only transport may call it; do not expose it through the app's fetch handler.
export class OwnerProvisioning {
  constructor(private readonly bootstrap: OwnerBootstrap) {}

  async execute(input: unknown): Promise<{ ok: true; challenge: string } | { ok: true } | { ok: false }> {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false };
      const request = input as Record<string, unknown>;
      if (request.operation === 'challenge' && Object.keys(request).length === 1) {
        return { ok: true, challenge: await this.bootstrap.issueChallenge() };
      }
      if (request.operation === 'enroll' && Object.keys(request).length === 3 &&
          typeof request.challenge === 'string' && request.response && typeof request.response === 'object' &&
          !Array.isArray(request.response)) {
        await this.bootstrap.enroll(request.challenge, request.response as RegistrationResponseJSON);
        return { ok: true };
      }
    } catch {
      // Do not disclose database or WebAuthn errors to the transport.
    }
    return { ok: false };
  }
}
