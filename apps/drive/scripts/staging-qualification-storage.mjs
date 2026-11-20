import { execFileSync } from 'node:child_process';
import { stagingStorage } from './staging-publish.mjs';

export async function readQualificationR2Binding(env, cwd, sha) {
  const receipt = JSON.parse(execFileSync('git', ['show', `${sha}:apps/drive/scripts/staging-storage-qualification.json`],
    { cwd, encoding: 'utf8', maxBuffer: 16_384, stdio: ['ignore', 'pipe', 'pipe'] }));
  const { vars, secrets } = await stagingStorage(env, receipt);
  // A current-object listing cannot certify cleanup of hidden versions on an
  // arbitrary S3 provider. Require the default-jurisdiction native R2 endpoint.
  const match = /^https:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com$/.exec(vars.DRIVE_S3_ENDPOINT);
  if (!match) throw new Error('Qualification requires a reviewed native R2 binding.');
  return { account: match[1], settings: { endpoint: vars.DRIVE_S3_ENDPOINT, bucket: vars.DRIVE_S3_BUCKET,
    region: vars.DRIVE_S3_REGION, accessKeyId: secrets.DRIVE_S3_ACCESS_KEY_ID, secretAccessKey: secrets.DRIVE_S3_SECRET_ACCESS_KEY } };
}
