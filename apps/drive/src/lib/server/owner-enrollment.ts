import { readBoundedBody } from './bounded-io';
import { OwnerBootstrap } from './identity/owner-bootstrap';
import { OwnerProvisioning } from './identity/owner-provisioning';
import { allowsOrigin, privateDriveOrigin } from './request-auth';

import type { DriveReleaseOrigin } from './qualification-readiness';

interface EnrollmentEnv extends DriveReleaseOrigin {
  DRIVE_OWNER_ENROLLMENT?: string;
  DRIVE_OWNER_ENROLLMENT_RELEASE?: string;
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
  // A locked body is a server failure, as when acquiring the reader failed here.
  if (request.body.locked) throw new TypeError('Enrollment request body is locked');
  try {
    const bytes = await readBoundedBody(request.body, {
      maxBytes: bodyLimit, maxReads: 256, timeoutMs: bodyReadMs, signal: request.signal,
    });
    return bytes && JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function enrollmentGrant(env: EnrollmentEnv) {
  const secret = env.DRIVE_OWNER_ENROLLMENT;
  if (typeof secret !== 'string' || secret.length !== 98) return null;
  const grant = /^([a-f0-9]{40}):(\d{13}):([A-Za-z0-9_-]{43})$/.exec(secret);
  const expiresAt = Number(grant?.[2]);
  const now = Date.now();
  if (!grant || grant[1] !== env.DRIVE_OWNER_ENROLLMENT_RELEASE ||
      expiresAt <= now || expiresAt > now + maxAuthorizationMs) return null;
  return { expiresAt, token: grant[3] };
}

export function admitsOwnerEnrollment(env: EnrollmentEnv): boolean {
  return enrollmentGrant(env) !== null;
}

export async function ownerEnrollment(request: Request, env: EnrollmentEnv): Promise<Response> {
  const origin = privateDriveOrigin(env);
  const grant = enrollmentGrant(env);
  if (!origin || !env.DB || !grant) return deny(503);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
  if (!allowsOrigin(request, origin) || new URL(request.url).search) return deny(403);
  const authorization = request.headers.get('authorization');
  const bearer = authorization?.length === 50 && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!bearer || !subtle.timingSafeEqual(encoder.encode(bearer[1]), encoder.encode(grant.token))) return deny(403);

  try {
    const input = await enrollmentInput(request);
    if (input === null || request.signal.aborted) return deny(400);
    // A suspended/revoked owner also permanently closes bootstrap. The SQL in
    // OwnerBootstrap independently enforces this at challenge and commit time.
    if (await env.DB.prepare("SELECT 1 FROM drive_principals WHERE role = 'owner' LIMIT 1").first()) return deny(409);
    const bootstrap = new OwnerBootstrap(env.DB, new URL(origin).hostname, origin, grant.expiresAt);
    const result = await new OwnerProvisioning(bootstrap).execute(input);
    return Response.json(result, { status: result.ok ? 200 : 400, headers });
  } catch {
    return deny(503);
  }
}
