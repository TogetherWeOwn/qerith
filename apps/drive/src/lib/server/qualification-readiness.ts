import { firstReleaseSmokePrefix, isQualificationRunNumber, qualificationPrefix } from './qualification-scope.mjs';

export const stagingOrigin = 'https://qerith-drive-staging.5150.workers.dev';
export interface DriveReleaseOrigin {
  DRIVE_ORIGIN?: string;
  DRIVE_FIRST_RELEASE_ORIGIN?: string;
}

// The additional origin comes from protected deployment bindings.
export function firstReleaseOrigin(env: DriveReleaseOrigin): string | null {
  const { DRIVE_ORIGIN: origin, DRIVE_FIRST_RELEASE_ORIGIN: release } = env;
  if (typeof origin !== 'string' || origin !== release) return null;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin ? origin : null;
  } catch { return null; }
}

export function privateDriveOrigin(env: DriveReleaseOrigin): string | null {
  return env.DRIVE_ORIGIN === stagingOrigin ? stagingOrigin : firstReleaseOrigin(env);
}

/** The ordinary release uses owner-managed storage. Qualification retains its pinned bindings. */
export function usesOwnerStorage(env: QualificationReadinessEnv): boolean {
  return env.DRIVE_ORIGIN !== stagingOrigin && firstReleaseOrigin(env) !== null &&
    env.DRIVE_SIGN_IN_FIXTURE !== '1' && env.DRIVE_QUALIFICATION_SHA === undefined && allowsQualificationTraffic(env);
}

export const readinessPath = '/api/deployer/qualification-readiness';
export const readinessHeaders = {
  nonce: 'x-drive-qualification-nonce',
  sha: 'x-drive-qualification-sha',
  version: 'x-drive-qualification-version',
};

export interface QualificationReadinessEnv extends DriveReleaseOrigin {
  DRIVE_SIGN_IN_FIXTURE?: string;
  DRIVE_FIRST_RELEASE_SMOKE_TOKEN?: string;
  DRIVE_QUALIFICATION_SHA?: string;
  DRIVE_QUALIFICATION_VERSION?: { id: string };
  DRIVE_QUALIFICATION_EXPIRES_AT?: string;
  DRIVE_QUALIFICATION_RUN_ID?: string;
  DRIVE_QUALIFICATION_RUN_ATTEMPT?: string;
}

export const qualificationWindowMs = 25 * 60_000;
const shaPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function qualificationTimeLeft(expiresAt: unknown, now = Date.now()): number {
  if (typeof expiresAt !== 'string' || !/^[1-9][0-9]{12}$/.test(expiresAt)) return 0;
  const remaining = Number(expiresAt) - now;
  return remaining > 0 && remaining <= qualificationWindowMs ? remaining : 0;
}

export function allowsQualificationTraffic(env: QualificationReadinessEnv, now = Date.now()): boolean {
  const { DRIVE_QUALIFICATION_SHA: sha, DRIVE_QUALIFICATION_VERSION: version,
    DRIVE_QUALIFICATION_EXPIRES_AT: expiresAt } = env;
  if (sha === undefined && version === undefined && expiresAt === undefined) {
    return env.DRIVE_ORIGIN === stagingOrigin ||
      [env.DRIVE_FIRST_RELEASE_SMOKE_TOKEN, env.DRIVE_QUALIFICATION_RUN_ID, env.DRIVE_QUALIFICATION_RUN_ATTEMPT]
        .every(value => value === undefined);
  }
  return privateDriveOrigin(env) !== null && env.DRIVE_SIGN_IN_FIXTURE !== '1' &&
    typeof sha === 'string' && shaPattern.test(sha) && typeof version?.id === 'string' && versionPattern.test(version.id) &&
    qualificationTimeLeft(expiresAt, now) > 0;
}

/** Empty for an ordinary deployment, null for an inadmissible candidate. */
export function qualificationAllocationPrefix(env: QualificationReadinessEnv, now = Date.now()) {
  const { DRIVE_QUALIFICATION_RUN_ID: runId, DRIVE_QUALIFICATION_RUN_ATTEMPT: attempt,
    DRIVE_QUALIFICATION_SHA: sha, DRIVE_QUALIFICATION_VERSION: version,
    DRIVE_QUALIFICATION_EXPIRES_AT: expiresAt } = env;
  if ([runId, attempt, sha, version, expiresAt].every(value => value === undefined)) return '';
  if (sha === undefined || !allowsQualificationTraffic(env, now) ||
      !isQualificationRunNumber(runId) || !isQualificationRunNumber(attempt)) return null;
  return env.DRIVE_ORIGIN === stagingOrigin
    ? qualificationPrefix({ runId, attempt }) : firstReleaseSmokePrefix({ runId, attempt });
}

export function admitsFirstReleaseSmokeRequest(request: Request, env: QualificationReadinessEnv): boolean {
  if (env.DRIVE_ORIGIN === stagingOrigin || env.DRIVE_QUALIFICATION_SHA === undefined) return true;
  const secret = env.DRIVE_FIRST_RELEASE_SMOKE_TOKEN;
  const supplied = request.headers.get('x-drive-smoke-token');
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret) ||
      supplied === null || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  const encoder = new TextEncoder();
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean };
  return subtle.timingSafeEqual(encoder.encode(supplied), encoder.encode(secret));
}

export function qualificationReadiness(request: Request, env: QualificationReadinessEnv, ready: boolean): Response {
  const headers = { 'cache-control': 'private, no-store' };
  const host = privateDriveOrigin(env);
  const origin = request.headers.get('origin');
  const nonce = request.headers.get(readinessHeaders.nonce);
  const sha = env.DRIVE_QUALIFICATION_SHA;
  const version = env.DRIVE_QUALIFICATION_VERSION?.id;
  // This reports binding readiness only. It does not open a session or read D1 or storage.
  if (host === null || env.DRIVE_SIGN_IN_FIXTURE === '1' ||
      request.url !== host + readinessPath || request.method !== 'HEAD' ||
      (origin !== null && origin !== host) || nonce === null || !/^[0-9a-f]{32}$/.test(nonce) ||
      typeof sha !== 'string' || !shaPattern.test(sha) || typeof version !== 'string' || !versionPattern.test(version)) {
    return new Response(null, { status: 404, headers });
  }
  if (!ready) return new Response(null, { status: 503, headers });
  return new Response(null, { status: 204, headers: { ...headers,
    [readinessHeaders.nonce]: nonce, [readinessHeaders.sha]: sha, [readinessHeaders.version]: version,
  } });
}
