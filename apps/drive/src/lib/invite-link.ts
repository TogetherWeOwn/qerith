let fragment = '';

export function captureInviteLink() {
  if (location.pathname !== '/invite' || !location.hash) return;
  // Strip the fragment before the router can retain it in history metadata.
  fragment = location.hash.slice(1);
  history.replaceState(history.state, '', '/invite');
}

export function takeInviteToken() {
  const token = fragment;
  fragment = '';
  return token;
}
