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
  const bytes = new Uint8Array(limit), reader = request.body.getReader();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(readMs)]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const deadline = performance.now() + readMs;
  try {
    let offset = 0, reads = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted || performance.now() >= deadline) { cancel(); return null; }
      if (done) break;
      if (value.byteLength > limit - offset) { cancel(); return null; }
      bytes.set(value, offset);
      offset += value.byteLength;
      // Even a stream of ready, empty chunks must yield to the deadline timer.
      if (++reads % 64 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (length !== null && offset !== limit) return null;
    const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset));
    const body = JSON.parse(json);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (uniqueFields && topLevelFieldCount(json) !== Object.keys(body).length) return null;
    return body;
  } catch { return null; }
  finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
