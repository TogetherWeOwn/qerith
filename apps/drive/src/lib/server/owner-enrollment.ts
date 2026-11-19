import { OwnerBootstrap } from './identity/owner-bootstrap';
import { OwnerProvisioning } from './identity/owner-provisioning';
import { allowsOrigin, stagingOrigin } from './request-auth';

interface EnrollmentEnv {
  DRIVE_OWNER_ENROLLMENT?: string;
  DB?: ConstructorParameters<typeof OwnerBootstrap>[0];
}

const maxAuthorizationMs = 300_000;
const bodyLimit = 32 * 1024;
const bodyReadMs = 2_000;
const encoder = new TextEncoder();
const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean };
const headers = { 'cache-control': 'private, no-store' };
const deny = (status: number) => new Response(null, { status, headers });

async function enrollmentInput(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' ||
      !request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(bodyLimit);
  const deadline = performance.now() + bodyReadMs;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; cancel(); }, bodyReadMs);
  let length = 0;
  try {
    // Also bound the number of reads so empty chunks cannot starve the timer.
    for (let reads = 0; reads < 256; reads++) {
      const { done, value } = await reader.read();
      if (timedOut || performance.now() >= deadline) break;
      if (done) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
      if (value.length > bytes.length - length) break;
      bytes.set(value, length);
      length += value.length;
    }
    cancel();
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function ownerEnrollment(request: Request, env: EnrollmentEnv): Promise<Response> {
  const secret = env.DRIVE_OWNER_ENROLLMENT;
  if (!env.DB || typeof secret !== 'string' || secret.length !== 57) return deny(503);
  const grant = /^(\d{13}):([A-Za-z0-9_-]{43})$/.exec(secret);
  const expiresAt = Number(grant?.[1]);
  const now = Date.now();
  if (!grant || expiresAt <= now || expiresAt > now + maxAuthorizationMs) return deny(503);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
  if (!allowsOrigin(request, stagingOrigin) || new URL(request.url).search) return deny(403);
  const authorization = request.headers.get('authorization');
  const bearer = authorization?.length === 50 && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!bearer || !subtle.timingSafeEqual(encoder.encode(bearer[1]), encoder.encode(grant[2]))) return deny(403);

  try {
    const input = await enrollmentInput(request);
    if (input === null) return deny(400);
    // A suspended/revoked owner also permanently closes bootstrap. The SQL in
    // OwnerBootstrap independently enforces this at challenge and commit time.
    if (await env.DB.prepare("SELECT 1 FROM drive_principals WHERE role = 'owner' LIMIT 1").first()) return deny(409);
    const bootstrap = new OwnerBootstrap(env.DB, new URL(stagingOrigin).hostname, stagingOrigin, expiresAt);
    const result = await new OwnerProvisioning(bootstrap).execute(input);
    return Response.json(result, { status: result.ok ? 200 : 400, headers });
  } catch {
    return deny(503);
  }
}
