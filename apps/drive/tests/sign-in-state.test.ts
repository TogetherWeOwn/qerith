import assert from 'node:assert/strict';
import test from 'node:test';
import { requestSignIn, signInCopy, type SignInState } from '../src/lib/sign-in-state';

test('sign-in copy exposes the documented passkey and retry states', () => {
  assert.equal(signInCopy['sign-in'].action, 'Sign in with a passkey');
  assert.equal(signInCopy.waiting.action, 'Waiting for your device…');
  assert.equal(signInCopy.cancelled.notice, "Nothing was saved. Try again when you're ready.");
  assert.match(signInCopy['no-passkey'].notice!, /ask the owner for a sign-in link/);
  assert.equal(signInCopy.unsupported.action, 'Sign in with a passkey');
  assert.equal(signInCopy.unsupported.notice, "This browser can't use passkeys. Try an up-to-date Chrome, Edge, Firefox or Safari.");
  assert.equal(signInCopy['rate-limited'].action, 'Try again in 1 min');
  assert.equal(signInCopy.revoked.action, undefined);
  assert.equal(signInCopy.revoked.title, 'Your access is turned off');
});

test('only actionable states invoke the injected sign-in callback', () => {
  const actionable: SignInState[] = ['sign-in', 'cancelled', 'no-passkey'];
  const inactive: SignInState[] = ['waiting', 'rate-limited', 'unsupported', 'revoked'];
  for (const [states, expected] of [[actionable, 1], [inactive, 0]] as const) {
    for (const state of states) {
      let calls = 0;
      requestSignIn(state, () => calls++);
      assert.equal(calls, expected, state);
    }
  }
});
