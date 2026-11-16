import assert from 'node:assert/strict';
import test from 'node:test';
import { createCeremonyVerifier } from '../src/lib/server/identity/ceremony';

import { rpID, origin, challenge, fixture } from './ceremony-fixture';

for (const kind of ['registration', 'authentication'] as const) {
  test(`${kind} verifies real signatures and rejects invalid ceremonies`, async () => {
    const verifier = createCeremonyVerifier(rpID, origin);
    const verify = async (options: Parameters<typeof fixture>[1] = {}, expected = challenge) => {
      const f = await fixture(kind, options);
      return kind === 'registration'
        ? verifier.registration(f.registration, expected)
        : verifier.authentication(f.authentication, expected, f.credential);
    };
    assert.equal((await verify()).verified, true);
    for (const options of [{ origin: 'https://wrong.test' }, { rpID: 'wrong.test' }, { uv: false }, { badSignature: true }]) {
      await assert.rejects(async () => { assert.equal((await verify(options)).verified, true); });
    }
    await assert.rejects(async () => { assert.equal((await verify({}, 'wrong')).verified, true); });
  });
}

test('relying party configuration cannot be request-shaped or insecure', () => {
  for (const [id, value] of [['example.test', 'http://example.test'], ['example.test', 'https://wrong.test'], ['example.test', 'https://example.test/path']]) {
    assert.throws(() => createCeremonyVerifier(id, value));
  }
});
