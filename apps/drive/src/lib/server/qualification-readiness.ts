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
      typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha) || typeof version !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(version)) {
    return new Response(null, { status: 404, headers });
  }
  if (!ready) return new Response(null, { status: 503, headers });
  return new Response(null, { status: 204, headers: { ...headers,
    [readinessHeaders.nonce]: nonce, [readinessHeaders.sha]: sha, [readinessHeaders.version]: version,
  } });
}
