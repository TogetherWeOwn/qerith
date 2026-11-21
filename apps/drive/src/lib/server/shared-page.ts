import { isTopLevelDocumentNavigation } from '../drive-navigation';

export const sharedRoute = '/shared';

export function isExactSharedDocument(request: Request, url: URL): boolean {
  const site = request.headers.get('sec-fetch-site');
  return (request.method === 'GET' || request.method === 'HEAD') &&
    (site === null || site === 'same-origin' || site === 'none') &&
    (!request.headers.has('sec-fetch-dest') || isTopLevelDocumentNavigation(request)) &&
    url.pathname === sharedRoute && !request.url.includes('#') &&
    request.url.split('?', 1)[0] === `${url.origin}${sharedRoute}`;
}

// This mirrors the landed shared listing contract: a seek boundary is opaque
// to the UI, not a path, identity or authorization input.
export const validSharedCursor = (value: string) => value.length > 0 && new TextEncoder().encode(value).length <= 512;

export function sharedPageCursor(search: string): string | null | undefined {
  if (search.length > 8192) return undefined;
  try { decodeURIComponent(search); } catch { return undefined; }
  const pairs = [...new URLSearchParams(search)];
  if (pairs.length === 0) return null;
  const [[key, value]] = pairs;
  return pairs.length === 1 && key === 'cursor' && validSharedCursor(value) ? value : undefined;
}
