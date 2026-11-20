const otherDrivePage = /^(?:\/|\/shared|\/people|\/shared\/f\/[A-Za-z0-9_-]+)$/;
export const isLinkableFolderId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
const drivePage = (path: string) => path.startsWith('/f/') ? isLinkableFolderId(path.slice(3)) : otherDrivePage.test(path);
const conditionalHeaders = ['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'];

export function driveNext(value: string | null): string {
  if (!value || /[\u0000- \u007f#]|%(?![0-9a-f]{2})/i.test(value)) return '/';
  // Match the raw path before any URL parser can normalize it. Only the query may be encoded.
  if (!drivePage(value.split('?', 1)[0])) return '/';
  const url = new URL(value, 'https://drive.invalid');
  return url.href.slice(url.origin.length);
}

export function isTopLevelDocumentNavigation(request: Request): boolean {
  const { headers } = request;
  // The link's source site does not determine whether the request is a document navigation.
  return (request.method === 'GET' || request.method === 'HEAD') &&
    headers.get('sec-fetch-mode') === 'navigate' && headers.get('sec-fetch-dest') === 'document' &&
    !conditionalHeaders.some((name) => headers.has(name));
}

export function isDrivePageNavigation(request: Request): boolean {
  return isTopLevelDocumentNavigation(request) && drivePage(new URL(request.url).pathname);
}
