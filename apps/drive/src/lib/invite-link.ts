let fragment = '';
let receive: ((token: string) => void) | undefined;

function capture(traversed = false) {
  if (location.pathname !== '/invite' || (!location.hash && !traversed)) return;
  // Revisiting a scrubbed history entry must not reuse the last invite.
  const token = location.hash.slice(1);
  if (location.hash) history.replaceState(history.state, '', '/invite');
  if (receive) receive(token);
  else fragment = token;
}

export function captureInviteLink() {
  capture();
  window.addEventListener('popstate', () => capture(true), true);
  window.addEventListener('hashchange', () => capture(), true);
}

export function observeInviteLinks(onToken: (token: string) => void) {
  receive = onToken;
  const token = fragment;
  fragment = '';
  onToken(token);
  return () => { receive = undefined; };
}
