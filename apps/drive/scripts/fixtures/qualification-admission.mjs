export const candidateAppSettings = Object.freeze({
  DRIVE_ORIGIN: 'https://qerith-drive-staging.5150.workers.dev',
  DRIVE_SIGN_IN_FIXTURE: '0',
  DRIVE_STAGING_INVITE_ACCEPTANCE: '1',
  DRIVE_STAGING_READ_GRANTS: '1',
  DRIVE_STAGING_SHARED_LISTING: '1',
  DRIVE_OWNER_ENROLLMENT_RELEASE: 'disabled',
});

export function fakeQualificationAdmission({ sha }) {
  const repository = 'TogetherWeOwn/qerith';
  const ref = 'refs/heads/main';
  const workflow = '.github/workflows/ci.yml';
  const review = ['general', 'security'].map((role, index) => ({
    repository, ref, workflow, sha, role, reviewerId: String(index + 1), verdict: 'APPROVE',
    policy: 'drive-staging-app-admission.v1', settings: { ...candidateAppSettings },
  }));
  const scope = { sha, runId: '101', attempt: '2' };
  const completed = { ...scope, status: 'completed', conclusion: 'success' };
  const digest = `sha256:${'a'.repeat(64)}`;
  const artifactId = '201';
  const aria = [
    '- text: Through Shared project',
    '- button "Confirm removal of direct access for Folder Reader"',
    '- status: Removed direct access for Folder Reader.',
  ].join('\n');
  return { review, browser: {
    run: { ...completed, repository, headRepository: repository, ref, workflow, workflowSha: sha, event: 'push',
      latestAttempt: scope.attempt },
    checks: {
      'drive browser fixture capture': {
        ...completed, steps: { 'Exercise registered generated fixtures in Chromium with local D1': 'success' },
      },
      'drive browser fixture evidence': {
        ...completed, artifactId, steps: { 'Verify evidence and record both provenance identities': 'success' },
      },
      'drive browser registry coverage': {
        ...completed, artifactId, steps: { 'Require registered sources and complete claimed evidence': 'success' },
      },
      'ci-ok': { ...completed },
    },
    artifact: { ...scope, id: artifactId, name: `drive-browser-${sha}`, digest, archiveDigest: digest, expired: false },
    provenance: { requestedHead: sha, testedCheckout: sha, integrationSnapshot: sha, policy: sha, base: null,
      snapshotBase: null, mode: 'head', workflow: 'ci', runId: scope.runId, runAttempt: scope.attempt,
      runUrl: `https://github.com/${repository}/actions/runs/${scope.runId}` },
    fixtures: {
      'staging-root-round-trip.json': {
        mode: 'staging-origin', signIn: 'passkey', refresh: { method: 'GET', path: '/__data.json', status: 200 },
        fullDownload: { bytes: 6, byteIdentical: true }, rangeDownload: { status: 206, contentRange: 'bytes 1-3/6', byteIdentical: true },
        denied: { signedOut: 401, member: 403, revoked: 401, wrongOrigin: 403, crossSite: 403, unlisted: 404 },
      },
      'staging-member-download.json': {
        full: { status: 200, bytes: 6, workerAndBrowserByteIdentical: true },
        range: { status: 206, contentRange: 'bytes 1-3/6', workerAndBrowserByteIdentical: true },
        shared: { full: 200, range: 206, byteIdentical: true, notListed: true },
        deniedWithoutStorage: { grantRevoked: 404, missing: 404, unpublished: 404, revoked: 401, flagOff: 403 },
      },
      'staging-shared-keyboard-390.json': { viewport: [390, 844], visibleFocus: true, skipToMain: true, keyboardDownload: true },
      'staging-shared-keyboard-1280.json': { viewport: [1280, 800], visibleFocus: true, skipToMain: true, keyboardDownload: true },
      'nested-share-aria-review-390.txt': aria,
      'nested-share-aria-review-1280.txt': aria,
    },
  } };
}
