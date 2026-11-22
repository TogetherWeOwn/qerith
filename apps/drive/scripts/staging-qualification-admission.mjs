import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { stagingOrigin } from '../src/lib/server/qualification-readiness.ts';
import { isQualificationRunNumber, qualificationPrefix } from '../src/lib/server/qualification-scope.mjs';
import { assertQualificationJob } from './staging-qualification.mjs';

const repository = 'TogetherWeOwn/qerith';
const ref = 'refs/heads/main';
const workflow = '.github/workflows/ci.yml';
const policy = 'drive-staging-app-admission.v1';
const settings = Object.freeze({
  DRIVE_ORIGIN: stagingOrigin,
  DRIVE_SIGN_IN_FIXTURE: '0',
  DRIVE_STAGING_INVITE_ACCEPTANCE: '1',
  DRIVE_STAGING_READ_GRANTS: '1',
  DRIVE_STAGING_SHARED_LISTING: '1',
  DRIVE_OWNER_ENROLLMENT_RELEASE: 'disabled',
});
const evidenceJob = 'drive browser fixture evidence';
const coverageJob = 'drive browser registry coverage';
const jobs = [
  ['drive browser fixture capture', 'Exercise registered generated fixtures in Chromium with local D1'],
  [evidenceJob, 'Verify evidence and record both provenance identities'],
  [coverageJob, 'Require registered sources and complete claimed evidence'],
  ['ci-ok'],
];
const admits = new WeakSet();
const unverified = () => new Error('Reviewed full-v0 admission is unverified.');
const successful = record => record?.status === 'completed' && record.conclusion === 'success';
const exactScope = (record, { sha, runId, attempt }) =>
  record?.sha === sha && record.runId === runId && record.attempt === attempt;

function assertReview(review, sha) {
  if (!Array.isArray(review) || review.length !== 2 ||
      new Set(review.map(item => item?.role)).size !== 2 ||
      new Set(review.map(item => item?.reviewerId)).size !== 2 ||
      !review.every(item => item?.repository === repository && item.ref === ref && item.sha === sha &&
        item.workflow === workflow && item.policy === policy && isDeepStrictEqual(item.settings, settings) &&
        isQualificationRunNumber(item.reviewerId) && ['general', 'security'].includes(item.role) &&
        item.verdict === 'APPROVE')) throw unverified();
}

function assertBrowserSource(browser, sha) {
  const { run, checks, artifact, provenance } = browser ?? {};
  const { runId, attempt } = run ?? {};
  if (!isQualificationRunNumber(runId) || !isQualificationRunNumber(attempt) ||
      run.latestAttempt !== attempt || !successful(run) || run.repository !== repository ||
      run.headRepository !== repository || run.event !== 'push' || run.ref !== ref ||
      run.workflow !== workflow || run.workflowSha !== sha || run.sha !== sha) throw unverified();

  if (!checks || Object.keys(checks).length !== jobs.length ||
      !jobs.every(([name, step]) => Object.hasOwn(checks, name) && successful(checks[name]) &&
        exactScope(checks[name], run) && (!step || checks[name].steps?.[step] === 'success'))) throw unverified();

  if (!exactScope(artifact, run) || artifact.name !== `drive-browser-${sha}` ||
      !isQualificationRunNumber(artifact.id) || typeof artifact.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) || artifact.archiveDigest !== artifact.digest ||
      artifact.expired !== false || checks[evidenceJob].artifactId !== artifact.id ||
      checks[coverageJob].artifactId !== artifact.id) throw unverified();

  if (provenance?.requestedHead !== sha || provenance.testedCheckout !== sha ||
      provenance.integrationSnapshot !== sha || provenance.policy !== sha || provenance.base !== null ||
      provenance.snapshotBase !== null || provenance.mode !== 'head' || provenance.workflow !== 'ci' ||
      provenance.runId !== runId || provenance.runAttempt !== attempt ||
      provenance.runUrl !== `https://github.com/${repository}/actions/runs/${runId}`) throw unverified();
}

function assertFixtureClaims(fixtures) {
  const owner = fixtures?.['staging-root-round-trip.json'];
  const member = fixtures?.['staging-member-download.json'];
  if (owner?.mode !== 'staging-origin' || owner.signIn !== 'passkey' ||
      !isDeepStrictEqual(owner.refresh, { method: 'GET', path: '/__data.json', status: 200 }) ||
      !isDeepStrictEqual(owner.fullDownload, { bytes: 6, byteIdentical: true }) ||
      !isDeepStrictEqual(owner.rangeDownload, { status: 206, contentRange: 'bytes 1-3/6', byteIdentical: true }) ||
      !isDeepStrictEqual(owner.denied, {
        signedOut: 401, member: 403, revoked: 401, wrongOrigin: 403, crossSite: 403, unlisted: 404,
      }) ||
      !isDeepStrictEqual(member?.full, { status: 200, bytes: 6, workerAndBrowserByteIdentical: true }) ||
      !isDeepStrictEqual(member.range, { status: 206, contentRange: 'bytes 1-3/6', workerAndBrowserByteIdentical: true }) ||
      !isDeepStrictEqual(member.shared, { full: 200, range: 206, byteIdentical: true, notListed: true }) ||
      !isDeepStrictEqual(member.deniedWithoutStorage, { grantRevoked: 404, missing: 404, unpublished: 404, revoked: 401, flagOff: 403 })) {
    throw unverified();
  }
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    if (!isDeepStrictEqual(fixtures[`staging-shared-keyboard-${width}.json`], {
      viewport: [width, height], visibleFocus: true, skipToMain: true, keyboardDownload: true,
    })) throw unverified();
    // The browser evidence job verifies the complete routed Share captures.
    // Require its grant management and inherited-access observations here too.
    const review = fixtures[`nested-share-aria-review-${width}.txt`];
    if (typeof review !== 'string' || review.length > 32_768) throw unverified();
    const lines = review.split('\n').map(line => line.trimStart());
    if (![
      'text: Through Shared project',
      'button "Confirm removal of direct access for Folder Reader"',
      'status: Removed direct access for Folder Reader.',
    ].every(node => lines.some(line => line.startsWith(`- ${node}`)))) throw unverified();
  }
}

function assertCleanCheckout(cwd) {
  execFileSync('git', ['diff', '--quiet', '--no-ext-diff', '--ignore-submodules=none', 'HEAD', '--'],
    { cwd, stdio: 'ignore', timeout: 5_000 });
}

// The reader must independently authenticate current approvals and Actions
// records, including the evidence job's output and coverage job's input IDs.
// It must extract provenance and fixed-name fixture claims from the same
// official ZIP whose SHA-256 it computed as archiveDigest, and bound and drain
// its reads on abort. There is no default reader.
export async function assertFullV0(env, cwd, readAdmissionEvidence, signal) {
  try {
    signal?.throwIfAborted();
    const source = assertQualificationJob(env, cwd);
    assertCleanCheckout(cwd);
    const { review, browser } = await readAdmissionEvidence(Object.freeze({
      ...source, prefix: qualificationPrefix(source),
    }), signal);
    signal?.throwIfAborted();
    if (!exactScope(assertQualificationJob(env, cwd), source)) throw unverified();
    assertCleanCheckout(cwd);
    assertReview(review, source.sha);
    assertBrowserSource(browser, source.sha);
    assertFixtureClaims(browser.fixtures);
    const admission = Object.freeze(source);
    admits.add(admission);
    return admission;
  } catch {
    throw unverified();
  }
}

export function admittedAppSettings(admission, source, cwd) {
  try {
    if (!admits.has(admission) || !exactScope(admission, source)) throw unverified();
    assertCleanCheckout(cwd);
    return settings;
  } catch {
    throw unverified();
  }
}
