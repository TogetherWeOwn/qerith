import assert from 'node:assert/strict';
import test from 'node:test';
import { createCeremonyVerifier } from '../src/lib/server/identity/ceremony';

import { rpID, origin, challenge, fixture } from './ceremony-fixture';

for (const kind of ['registration', 'authentication'] as const) {
  test(`${kind} verifies real signatures and rejects invalid ceremonies`, async () => {
    const verifier = createCeremonyVerifier(rpID, origin);
    const verify = async (f: Awaited<ReturnType<typeof fixture>>, expected = challenge) => kind === 'registration'
      ? verifier.registration(f.registration, expected)
      : verifier.authentication(f.authentication, expected, f.credential);
    assert.equal((await verify(await fixture(kind))).verified, true);
    for (const options of [{ origin: 'https://wrong.test' }, { rpID: 'wrong.test' }, { uv: false }, { badSignature: true }, { crossOrigin: true }, { topOrigin: 'https://wrong.test' }]) {
      const data = await fixture(kind, options);
      const result = await verify(data).catch(() => ({ verified: false }));
      assert.equal(result.verified, false);
    }
    const data = await fixture(kind);
    const result = await verify(data, 'wrong').catch(() => ({ verified: false }));
    assert.equal(result.verified, false);
  });
}

test('authentication rejects a credential ID mismatch', async () => {
  const data = await fixture('authentication');
  const verifier = createCeremonyVerifier(rpID, origin);
  await assert.rejects(verifier.authentication(data.authentication, challenge, { ...data.credential, id: 'different' }), /Credential ID mismatch/);
});

test('invalid client data rejects the returned promises', async () => {
  const verifier = createCeremonyVerifier(rpID, origin);
  const registration = await fixture('registration', { crossOrigin: true });
  const authentication = await fixture('authentication', { crossOrigin: true });
  await assert.rejects(verifier.registration(registration.registration, challenge), /Cross-origin/);
  await assert.rejects(verifier.authentication(authentication.authentication, challenge, authentication.credential), /Cross-origin/);
});

test('relying party configuration cannot be request-shaped or insecure', () => {
  for (const [id, value] of [['example.test', 'http://example.test'], ['example.test', 'https://wrong.test'], ['example.test', 'https://example.test/path']]) {
    assert.throws(() => createCeremonyVerifier(id, value));
  }
});
