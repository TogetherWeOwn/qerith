export const stagingOrigin = 'https://qerith-drive-staging.5150.workers.dev';
export const readinessPath = '/api/deployer/qualification-readiness';
export const readinessHeaders = {
  nonce: 'x-drive-qualification-nonce',
  sha: 'x-drive-qualification-sha',
  version: 'x-drive-qualification-version',
};

export interface QualificationReadinessEnv {
  DRIVE_ORIGIN?: string;
  DRIVE_SIGN_IN_FIXTURE?: string;
  DRIVE_QUALIFICATION_SHA?: string;
  DRIVE_QUALIFICATION_VERSION?: { id: string };
  DRIVE_QUALIFICATION_EXPIRES_AT?: string;
  DRIVE_QUALIFICATION_RUN_ID?: string;
  DRIVE_QUALIFICATION_RUN_ATTEMPT?: string;
}

export const qualificationWindowMs = 25 * 60_000;
export const qualificationFixtureNamespace = 'drive-qualification/full-v0/';
const shaPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function isQualificationRunNumber(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
}

export function qualificationPrefix({ runId, attempt }: { runId: unknown; attempt: unknown }) {
  if (!isQualificationRunNumber(runId) || !isQualificationRunNumber(attempt)) {
    throw new Error('Invalid qualification run or attempt.');
  }
  return `${qualificationFixtureNamespace}${runId}/${attempt}/` as const;
}

export function qualificationTimeLeft(expiresAt: unknown, now = Date.now()): number {
  if (typeof expiresAt !== 'string' || !/^[1-9][0-9]{12}$/.test(expiresAt)) return 0;
  const remaining = Number(expiresAt) - now;
  return remaining > 0 && remaining <= qualificationWindowMs ? remaining : 0;
}

export function allowsQualificationTraffic(env: QualificationReadinessEnv, now = Date.now()): boolean {
  const { DRIVE_QUALIFICATION_SHA: sha, DRIVE_QUALIFICATION_VERSION: version,
    DRIVE_QUALIFICATION_EXPIRES_AT: expiresAt } = env;
  if (sha === undefined && version === undefined && expiresAt === undefined) return true;
  return env.DRIVE_ORIGIN === stagingOrigin && env.DRIVE_SIGN_IN_FIXTURE !== '1' &&
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
  return qualificationPrefix({ runId, attempt });
}

export function qualificationReadiness(request: Request, env: QualificationReadinessEnv, ready: boolean): Response {
  const headers = { 'cache-control': 'private, no-store' };
  const origin = request.headers.get('origin');
  const nonce = request.headers.get(readinessHeaders.nonce);
  const sha = env.DRIVE_QUALIFICATION_SHA;
  const version = env.DRIVE_QUALIFICATION_VERSION?.id;
  // This reports binding readiness only. It does not open a session or read D1 or storage.
  if (env.DRIVE_ORIGIN !== stagingOrigin || env.DRIVE_SIGN_IN_FIXTURE === '1' ||
      request.url !== stagingOrigin + readinessPath || request.method !== 'HEAD' ||
      (origin !== null && origin !== stagingOrigin) || nonce === null || !/^[0-9a-f]{32}$/.test(nonce) ||
      typeof sha !== 'string' || !shaPattern.test(sha) || typeof version !== 'string' || !versionPattern.test(version)) {
    return new Response(null, { status: 404, headers });
  }
  if (!ready) return new Response(null, { status: 503, headers });
  return new Response(null, { status: 204, headers: { ...headers,
    [readinessHeaders.nonce]: nonce, [readinessHeaders.sha]: sha, [readinessHeaders.version]: version,
  } });
}
