export const readGrantCollectionRoute = '/api/entries/[entryId]/read-grants';
export const readGrantRecipientRoute = `${readGrantCollectionRoute}/[recipientId]`;
export const readGrantPath = /^\/api\/entries\/([^/]{1,1536})\/read-grants(?:\/([^/]{1,1536}))?$/;
const encoder = new TextEncoder();
const originalGrantRequest = Symbol.for('qerith.drive.originalGrantRequest');

// SvelteKit strips these suffixes before its hook. Escape them only after Worker
// admission, and carry the canonical request in memory, never in a wire header.
export function readGrantAdapterRequest(request: Request, url: URL): Request {
  const pathname = url.pathname.replace(/(\/|\.html)_(_(?:data\.json|route\.js))$/, '$1%5F$2');
  if (pathname === url.pathname) return request;
  url.pathname = pathname;
  return Object.assign(new Request(url, request), { [originalGrantRequest]: request });
}

export function readGrantOriginalRequest(request: Request): Request {
  return (request as Request & { [originalGrantRequest]?: Request })[originalGrantRequest] ?? request;
}
export const validReadGrantId = (id: string) => id.length > 0 && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(id) && encoder.encode(id).length <= 512;

// An ID is data, not a pathname or a UUID. Accept one canonical wire spelling.
export function decodeReadGrantId(wire: string): string | null {
  if (wire.length > 1536) return null;
  try {
    const id = decodeURIComponent(wire);
    return validReadGrantId(id) && encodeURIComponent(id).replaceAll("'", '%27') === wire ? id : null;
  } catch { return null; }
}

// Null means no cursor; undefined means the request query is invalid.
export function readGrantCursor(method: string, search: string): string | null | undefined {
  if (search === '') return null;
  if (method !== 'GET' || !search.startsWith('?cursor=')) return undefined;
  return decodeReadGrantId(search.slice(8)) ?? undefined;
}

export function readGrantAdmissionRoute(request: Request, url: URL): string | null {
  if (request.url !== url.origin + url.pathname + url.search) return null;
  const match = readGrantPath.exec(url.pathname);
  if (!match || decodeReadGrantId(match[1]) === null) return null;
  if (match[2] === undefined) return request.method === 'GET' ? readGrantCollectionRoute : null;
  return (request.method === 'PUT' || request.method === 'DELETE') && decodeReadGrantId(match[2]) !== null
    ? readGrantRecipientRoute : null;
}
