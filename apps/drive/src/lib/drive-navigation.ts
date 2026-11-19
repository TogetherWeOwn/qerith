const drivePage = /^(?:\/|\/shared|\/people|\/(?:shared\/)?f\/[A-Za-z0-9_-]+)$/;
const conditionalHeaders = ['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'];

export function driveNext(value: string | null): string {
  if (!value || /[\u0000- \u007f#]|%(?![0-9a-f]{2})/i.test(value)) return '/';
  // Match the raw path before any URL parser can normalize it. Only the query may be encoded.
  if (!drivePage.test(value.split('?', 1)[0])) return '/';
  const url = new URL(value, 'https://drive.invalid');
  return url.href.slice(url.origin.length);
}

export function isDrivePageNavigation(request: Request): boolean {
  const { headers } = request;
  const site = headers.get('sec-fetch-site');
  return (request.method === 'GET' || request.method === 'HEAD') &&
    (site === 'same-origin' || site === 'none') &&
    headers.get('sec-fetch-mode') === 'navigate' && headers.get('sec-fetch-dest') === 'document' &&
    !conditionalHeaders.some((name) => headers.has(name)) && drivePage.test(new URL(request.url).pathname);
}
