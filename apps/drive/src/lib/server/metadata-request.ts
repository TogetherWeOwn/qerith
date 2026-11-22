import { readBoundedBody } from './bounded-io';

export { isMetadataId } from '../metadata-id';

const bodyLimit = 5 * 1024;
const readMs = 2_000;
const encoder = new TextEncoder();

// In valid JSON, each colon outside a string at depth one is an object field separator.
function topLevelFieldCount(json: string): number {
  let depth = 0, count = 0, quoted = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (quoted && ch === '\\') i++;
    else if (ch === '"') quoted = !quoted;
    else if (!quoted) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      else if (ch === ':' && depth === 1) count++;
    }
  }
  return count;
}

export async function readMetadataJson(request: Request, { uniqueFields = false } = {}): Promise<Record<string, unknown> | null> {
  const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const length = request.headers.get('content-length');
  if (type !== 'application/json' || request.headers.has('content-encoding') || !request.body ||
      request.body.locked || request.signal.aborted ||
      (length !== null && (!/^[1-9][0-9]{0,3}$/.test(length) || +length > bodyLimit))) return null;

  const limit = length === null ? bodyLimit : +length;
  try {
    const bytes = await readBoundedBody(request.body, {
      maxBytes: limit, exact: length !== null, timeoutMs: readMs, signal: request.signal,
    });
    if (!bytes || request.signal.aborted) return null;
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const body = JSON.parse(json);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (uniqueFields && topLevelFieldCount(json) !== Object.keys(body).length) return null;
    return body;
  } catch { return null; }
}
