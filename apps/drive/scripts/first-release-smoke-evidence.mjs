import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { firstReleaseUploadCapBytes } from '../src/lib/server/first-release-upload-limit.mjs';

const cases = ['invite', 'uninvitedDenial', 'share', 'revoke', 'multipartResume', 'byteIdenticalDownload',
  'overCapRefusal', 'permanentDeletionUnavailable'];
export const versionIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

// Call only after the venue's cleanup has been verified.
export async function writeSmokeReceipt(runPath, scope, outcome, stagingVenue, localStorage) {
  if (!versionIdPattern.test(outcome.workerVersion) || Object.keys(outcome.cases).length !== cases.length ||
      !cases.every(name => outcome.cases[name] === 'pass')) throw new Error('Smoke case evidence is incomplete');
  const { sha: sourceSha, runId, runAttempt, buildDigest } = scope;
  const receipt = {
    version: 2, stagingVenue, sourceSha, runId, runAttempt, buildDigest,
    workerVersion: outcome.workerVersion, testedSizeCapBytes: firstReleaseUploadCapBytes,
    cases: { ...outcome.cases, cleanup: 'pass' }, localStorage,
  };
  await writeFile(join(runPath, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
