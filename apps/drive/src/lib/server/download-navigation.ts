export { entryId } from '../download-id';

export const downloadRoute = '/api/download/[fileId]';
export const downloadNoticeCookie = (nonce: string) => `__Host-drive-download-failed-${nonce}`;

// Until folder routes are admitted, return to the canonical Drive root. No
// path from a request or from a failed/denied file lookup becomes a destination.
export const downloadFolder = '/';
export const downloadSignIn = `/sign-in?${new URLSearchParams({ next: downloadFolder })}`;

export function isDownloadNavigation(request: Request) {
  const { headers } = request;
  const site = headers.get('sec-fetch-site');
  return request.method === 'GET' && (site === 'same-origin' || site === 'none') &&
    headers.get('sec-fetch-mode') === 'navigate' && headers.get('sec-fetch-dest') === 'document' &&
    !['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since']
      .some((name) => headers.has(name));
}

export function downloadRedirect(location: string) {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'private, no-store' } });
}
