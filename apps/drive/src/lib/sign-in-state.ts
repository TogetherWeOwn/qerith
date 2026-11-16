// Presentation state only. Authentication and navigation are supplied by the caller.
export type SignInState =
  | 'sign-in'
  | 'waiting'
  | 'cancelled'
  | 'no-passkey'
  | 'unsupported'
  | 'revoked'
  | 'rate-limited';

export function canSignIn(state: SignInState): boolean {
  return state === 'sign-in' || state === 'cancelled' || state === 'no-passkey';
}

export function requestSignIn(state: SignInState, onSignIn: () => void): void {
  if (canSignIn(state)) onSignIn();
}

export interface SignInCopy {
  title: string;
  body: string;
  action?: string;
  notice?: string;
}

const description = 'Drive is invite-only. If you lost your passkey, ask the owner for a sign-in link.';
const action = 'Sign in with a passkey';

export const signInCopy: Record<SignInState, SignInCopy> = {
  'sign-in': { title: 'Sign in to Drive', body: description, action },
  waiting: { title: 'Sign in to Drive', body: description, action: 'Waiting for your device…', notice: "Follow your browser's prompt." },
  cancelled: { title: 'Sign in to Drive', body: description, action, notice: "Nothing was saved. Try again when you're ready." },
  'no-passkey': { title: 'Sign in to Drive', body: description, action, notice: "This device doesn't have a passkey for Drive. Use the device you set it up on, or ask the owner for a sign-in link." },
  unsupported: { title: 'Sign in to Drive', body: description, action, notice: "This browser can't use passkeys. Try an up-to-date Chrome, Edge, Firefox or Safari." },
  revoked: { title: 'Your access is turned off', body: 'The owner turned off your access to Drive. Your files are kept. Ask them if you think this is a mistake.' },
  'rate-limited': { title: 'Sign in to Drive', body: description, action: 'Try again in 1 min', notice: 'Too many tries. Wait a minute, then try again.' },
};
