import { createCeremonyVerifier } from '../src/lib/server/identity/ceremony';
import { challenge, fixture, origin, rpID } from './ceremony-fixture';

export default {
  async fetch() {
    try {
      const verifier = createCeremonyVerifier(rpID, origin);
      for (const kind of ['registration', 'authentication'] as const) {
        for (const options of [{}, { origin: 'https://wrong.test' }, { rpID: 'wrong.test' }, { uv: false }, { badSignature: true }]) {
          const data = await fixture(kind, options);
          let verified = false;
          try {
            const result = kind === 'registration'
              ? await verifier.registration(data.registration, challenge)
              : await verifier.authentication(data.authentication, challenge, data.credential);
            verified = result.verified;
          } catch { /* A rejected ceremony is expected for negative cases. */ }
          if (verified !== (Object.keys(options).length === 0)) throw new Error(`${kind} verification mismatch`);
        }
      }
      return new Response('ceremony-runtime-ok');
    } catch (error) {
      console.error(error);
      return new Response('ceremony-runtime-failed', { status: 500 });
    }
  },
};
