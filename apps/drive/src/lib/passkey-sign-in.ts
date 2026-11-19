import type { SignInState } from './sign-in-state';

type Outcome = 'signed-in' | Extract<SignInState, 'cancelled' | 'no-passkey' | 'revoked' | 'rate-limited'>;

interface SignInBrowser {
  exclusive<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T>;
  fetch: typeof fetch;
  assertion(options: PublicKeyCredentialRequestOptionsJSON, signal: AbortSignal): Promise<unknown | null>;
}

export function passkeyBrowser(): SignInBrowser | null {
  if (typeof PublicKeyCredential === 'undefined' ||
      typeof PublicKeyCredential.parseRequestOptionsFromJSON !== 'function' ||
      typeof PublicKeyCredential.prototype.toJSON !== 'function' ||
      !navigator.credentials || !navigator.locks) return null;
  return {
    exclusive: (signal, run) => navigator.locks.request('drive-passkey-sign-in', { mode: 'exclusive', signal }, run),
    fetch: window.fetch.bind(window),
    async assertion(options, signal) {
      const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(options);
      const credential = await navigator.credentials.get({ publicKey, signal });
      return credential instanceof PublicKeyCredential ? credential.toJSON() : null;
    },
  };
}

async function responseCode(response: Response): Promise<unknown> {
  return (await response.json())?.code;
}

export async function signInWithPasskey(browser: SignInBrowser, signal: AbortSignal): Promise<Outcome> {
  const init: RequestInit = { cache: 'no-store', credentials: 'same-origin', redirect: 'error' };
  const post = (step: 'challenge' | 'restart' | 'verify', assertion?: unknown) =>
    browser.fetch(`/api/sign-in/${step}`, {
      ...init, method: 'POST', ...(assertion === undefined ? {} : {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(assertion),
      }),
    });

  try {
    // Hold the origin-wide lock until Fetch has processed the final response headers,
    // including Set-Cookie. Cancel the queue or authenticator, not an in-flight POST.
    return await browser.exclusive(signal, async (): Promise<Outcome> => {
      const session = await browser.fetch('/', { ...init, method: 'HEAD', signal });
      if (session.status === 200) return 'signed-in';
      if (session.status !== 401) return 'cancelled';
      signal.throwIfAborted();

      let options = await post('challenge');
      if (options.status === 409 && await responseCode(options) === 'restart-required') {
        // No other tab can have installed a session since the probe inside this lock.
        signal.throwIfAborted();
        options = await post('restart');
      }
      if (options.status === 429 && await responseCode(options) === 'rate-limited') return 'rate-limited';
      if (options.status !== 200) return 'cancelled';
      const publicKey = await options.json() as PublicKeyCredentialRequestOptionsJSON;
      signal.throwIfAborted();
      const assertion = await browser.assertion({ ...publicKey, userVerification: 'required' }, signal);
      signal.throwIfAborted();
      if (assertion === null) return 'no-passkey';

      const proof = await post('verify', assertion);
      if (proof.status === 204) return 'signed-in'; // The session cookie has already been received.
      signal.throwIfAborted();
      if (proof.status === 403 && await responseCode(proof) === 'revoked') return 'revoked';
      if (proof.status === 429 && await responseCode(proof) === 'rate-limited') return 'rate-limited';
      return 'cancelled';
    });
  } catch (error) {
    // WebAuthn intentionally does not distinguish some timeouts, cancellations,
    // and no-credential results. Do not claim the device lacks a passkey then.
    return !signal.aborted && error instanceof DOMException && error.name === 'NotFoundError'
      ? 'no-passkey' : 'cancelled';
  }
}
