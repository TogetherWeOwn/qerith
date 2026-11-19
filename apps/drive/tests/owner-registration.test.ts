import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { createOwnerEnrollment } from '../src/lib/owner-registration';
import { fixture, rpID } from './ceremony-fixture';

void test('deployer browser forwards the issued user ID and challenge to WebAuthn', async (t) => {
  const handle = crypto.getRandomValues(new Uint8Array(32));
  const options = await generateRegistrationOptions({
    rpID, rpName: 'Drive', userName: 'Drive owner', userID: handle,
  });
  const { registration } = await fixture('registration', { challenge: options.challenge });
  const parsed = { user: { id: handle } };
  class BrowserCredential {
    static parseCreationOptionsFromJSON(input: unknown) {
      assert.equal(input, options);
      return parsed;
    }
    toJSON() { return registration; }
  }
  function stub(object: object, key: string, value: unknown) {
    const original = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(object, key, original);
      else Reflect.deleteProperty(object, key);
    });
  }
  stub(globalThis, 'PublicKeyCredential', BrowserCredential);
  stub(navigator, 'credentials', {
    async create(input: unknown) {
      assert.deepEqual(input, { publicKey: parsed });
      return new BrowserCredential();
    },
  });
  assert.deepEqual(await createOwnerEnrollment(options), {
    operation: 'enroll', challenge: options.challenge, response: registration,
  });
});
