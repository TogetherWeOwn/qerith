import { entryId } from '../download-id';
import { isTopLevelDocumentNavigation } from '../drive-navigation';

export { entryId };

export function isExactDownloadGet(method: string, pathname: string) {
  const prefix = '/api/download/';
  return method === 'GET' && pathname.startsWith(prefix) && entryId.test(pathname.slice(prefix.length));
}

export const downloadRoute = '/api/download/[fileId]';
export const downloadNoticeCookie = (nonce: string) => `__Host-drive-download-failed-${nonce}`;

// Until folder routes are admitted, return to the canonical Drive root. No
// path from a request or from a failed/denied file lookup becomes a destination.
export const downloadFolder = '/';
export const downloadSignIn = `/sign-in?${new URLSearchParams({ next: downloadFolder })}`;

export function isDownloadDocumentNavigation(request: Request) {
  return request.method === 'GET' && isTopLevelDocumentNavigation(request);
}

export function isDownloadNavigation(request: Request) {
  // Keep the authenticated download failure notice scoped to same-origin and direct visits.
  const site = request.headers.get('sec-fetch-site');
  return (site === 'same-origin' || site === 'none') && isDownloadDocumentNavigation(request);
}

export function downloadRedirect(location: string) {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'private, no-store' } });
}
