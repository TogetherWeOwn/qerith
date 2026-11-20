import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createQualificationR2Cleanup } from './staging-qualification-cleanup.mjs';

const bucket = 'fixture-bucket';
const endpoint = `https://${'abc01234'.repeat(4)}.r2.cloudflarestorage.com`;
const prefix = 'drive-qualification/full-v0/182/3/';
const key = `${prefix}fixture + name`;
const uploadId = 'fixture+/=';

function job(t, target = endpoint) {
  const cwd = mkdtempSync(join(tmpdir(), 'drive-qualification-r2-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Drive', '-c', 'user.email=drive@example.test',
    '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main', '--template=');
  const dir = join(cwd, 'apps/drive/scripts');
  mkdirSync(dir, { recursive: true });
  const identitySha256 = createHash('sha256').update(JSON.stringify([JSON.stringify([target, bucket, 'fixture-epoch']),
    'auto', 'fixture-key'])).digest('hex');
  writeFileSync(join(dir, 'staging-storage-qualification.json'), JSON.stringify({ version: 1, passed: true, failures: [],
    cleanup: 'verified', scope: { identitySha256, policySha256: 'a'.repeat(64) },
    sourceSha: 'b'.repeat(40), runId: '123', runAttempt: 1, completionTimeoutMs: 3000 }));
  git('add', '.');
  git('commit', '-qm', 'reviewed synthetic storage binding');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const env = { GITHUB_REPOSITORY: 'TogetherWeOwn/qerith', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    TESTED_SHA: sha, GITHUB_SHA: sha, GITHUB_ACTIONS: 'true', GITHUB_JOB: 'qualification',
    GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/drive-staging-qualification.yml@refs/heads/main',
    GITHUB_RUN_ID: '182', GITHUB_RUN_ATTEMPT: '3', QERITH_S3_ENDPOINT: target, QERITH_S3_BUCKET: bucket,
    QERITH_S3_REGION: 'auto', QERITH_S3_STORAGE_EPOCH: 'fixture-epoch',
    QERITH_S3_ACCESS_KEY_ID: 'fixture-key', QERITH_S3_SECRET_ACCESS_KEY: 'fixture-secret' };
  return { cwd, env, context: { sha, prefix, runId: '182', attempt: '3' } };
}

function signedFixture({ postPrefix = prefix, count = '1', proofBucket = bucket, postPendingPrefix = prefix } = {}) {
  const trace = [];
  let pending = true, present = true;
  const send = async request => {
    const url = new URL(request.url);
    trace.push(request.method);
    assert.equal(url.origin, endpoint);
    assert.equal(request.redirect, 'manual');
    assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
    if (request.method === 'GET') {
      assert.equal(url.pathname, `/${bucket}/`);
      assert.equal(url.searchParams.get('prefix'), prefix);
      const envelope = scope => `<Prefix>${encodeURIComponent(scope)}</Prefix><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>`;
      if (url.searchParams.has('uploads')) {
        const record = pending ? `<Upload><Key>${encodeURIComponent(key)}</Key><UploadId>${uploadId}</UploadId></Upload>` : '';
        return new Response(`<ListMultipartUploadsResult><Bucket>${bucket}</Bucket>${envelope(pending ? prefix : postPendingPrefix)}${record}</ListMultipartUploadsResult>`);
      }
      assert.equal(url.searchParams.get('list-type'), '2');
      const record = present ? `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>` : '';
      return new Response(`<ListBucketResult><Name>${proofBucket}</Name>${envelope(present ? prefix : postPrefix)}<KeyCount>${present ? count : 0}</KeyCount>${record}</ListBucketResult>`);
    }
    assert.equal(request.method, 'DELETE');
    assert.equal(decodeURIComponent(url.pathname), `/${bucket}/${key}`);
    if (url.searchParams.has('uploadId')) {
      assert.equal(url.searchParams.get('uploadId'), uploadId);
      pending = false;
    } else present = false;
    return new Response(null, { status: 204 });
  };
  return { send, trace };
}

test('the protected R2 adapter signs and scopes every request with a reviewed binding', async t => {
  const { cwd, env, context } = job(t);
  const { send, trace } = signedFixture();
  await assert.rejects(createQualificationR2Cleanup({ ...env, QERITH_S3_BUCKET: 'other-bucket' }, cwd, { send }), /does not match/);
  await assert.rejects(createQualificationR2Cleanup({ ...env, GITHUB_JOB: 'preview' }, cwd, { send }), /protected staging/);
  const unreviewedProvider = job(t, 'https://storage.example.test');
  await assert.rejects(createQualificationR2Cleanup(unreviewedProvider.env, unreviewedProvider.cwd, { send }), /cleanup is unverified/);
  const cleanup = await createQualificationR2Cleanup(env, cwd, { send });
  assert.throws(() => cleanup({ ...context, sha: 'f'.repeat(40) }), /cleanup is unverified/);
  assert.deepEqual(trace, []);
  assert.equal(await cleanup(context), true);
  assert.deepEqual(trace, ['GET', 'GET', 'DELETE', 'DELETE', 'GET', 'GET']);
});

test('signed R2 cleanup rejects scope and enumeration mismatches', async t => {
  const { cwd, env, context } = job(t);
  for (const [options, expected] of [
    [{ count: '0' }, ['GET', 'GET']],
    [{ proofBucket: 'other-bucket' }, ['GET', 'GET']],
    [{ postPrefix: 'other-prefix/' }, ['GET', 'GET', 'DELETE', 'DELETE', 'GET', 'GET']],
    [{ postPendingPrefix: 'other-prefix/' }, ['GET', 'GET', 'DELETE', 'DELETE', 'GET']],
  ]) {
    const { send, trace } = signedFixture(options);
    const cleanup = await createQualificationR2Cleanup(env, cwd, { send });
    await assert.rejects(cleanup(context), /cleanup is unverified/);
    assert.deepEqual(trace, expected);
  }
});
