import { createSessionFolder } from './metadata/create-folder';
import { validateName } from './metadata/private';
import { admitsSignInFixture, allowsOrigin, readSessionToken, type DriveAuthEnv } from './request-auth';

type FolderEnv = DriveAuthEnv & { DB?: { withSession(constraint: 'first-primary'): Parameters<typeof createSessionFolder>[0] } };
const headers = { 'cache-control': 'private, no-store' };
const reply = (status: number) => new Response(null, { status, headers: status === 405 ? { ...headers, allow: 'POST' } : headers });
const bodyLimit = 5 * 1024;
const readMs = 2_000;
const encoder = new TextEncoder();

async function readFolderBody(request: Request): Promise<{ name: string; parentId: string | null } | null> {
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
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 2 ||
        !Object.hasOwn(body, 'name') || !Object.hasOwn(body, 'parentId')) return null;
    const { name, parentId } = body;
    // Stored IDs are opaque, not paths or necessarily UUIDs. Reject malformed text, never normalize it.
    if (parentId !== null && (typeof parentId !== 'string' || parentId.length === 0 ||
        /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(parentId) || encoder.encode(parentId).length > 512)) return null;
    validateName(name);
    return { name, parentId };
  } catch { return null; }
  finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export async function postFolder(request: Request, env: FolderEnv): Promise<Response> {
  if (!admitsSignInFixture(env)) return reply(404);
  if (request.method !== 'POST') return reply(405);
  const site = request.headers.get('sec-fetch-site');
  if (!allowsOrigin(request, env.DRIVE_ORIGIN ?? '') || (site !== null && site !== 'same-origin')) return reply(403);
  if (request.url !== `${env.DRIVE_ORIGIN}/api/folders`) return reply(404);
  const token = readSessionToken(request);
  if (!token) return reply(401);
  const db = env.DB;
  if (typeof db?.withSession !== 'function') return reply(503);
  const input = await readFolderBody(request);
  if (!input || request.signal.aborted) return reply(400);
  try {
    const folder = await createSessionFolder(db.withSession('first-primary'), token, input.parentId, input.name);
    if (typeof folder === 'number') return reply(folder);
    const { id, parentId, name, kind } = folder;
    return Response.json({ id, parentId, name, kind }, { status: 201, headers });
  } catch { return reply(503); }
}
