let fragment = '';
let receive: ((token: string) => void) | undefined;

function capture() {
  if (location.pathname !== '/invite' || !location.hash) return;
  // Strip the fragment before the router can retain it in history metadata.
  const token = location.hash.slice(1);
  history.replaceState(history.state, '', '/invite');
  if (receive) receive(token);
  else fragment = token;
}

export function captureInviteLink() {
  capture();
  // A second link to the same path can navigate without mounting a new page.
  window.addEventListener('popstate', capture, true);
  window.addEventListener('hashchange', capture, true);
}

export function observeInviteLinks(onToken: (token: string) => void) {
  receive = onToken;
  const token = fragment;
  fragment = '';
  onToken(token);
  return () => { receive = undefined; };
}
