const bodyLimit = 5 * 1024;
const readMs = 2_000;
const encoder = new TextEncoder();

// Stored IDs are opaque, not paths or necessarily UUIDs. Reject malformed text, never normalize it.
export function isMetadataId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 512 &&
    !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(id) && encoder.encode(id).length <= 512;
}

export async function readMetadataJson(request: Request): Promise<Record<string, unknown> | null> {
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
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset)));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; }
  finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
