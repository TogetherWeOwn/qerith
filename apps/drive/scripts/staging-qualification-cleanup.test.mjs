import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createQualificationR2Cleanup } from './staging-qualification-cleanup.mjs';
import { verifyQualificationR2Expiry } from './staging-qualification-expiry.mjs';
import { qualificationRecoveryWriter } from './staging-qualification-recovery-record.mjs';
import { createQualificationR2RecoveryStore } from './staging-qualification-recovery-r2.mjs';
import { assertQualificationSettings } from './staging-qualification-settings.mjs';
import { createQualificationStorageCases } from './staging-qualification-storage-cases.mjs';
import { createQualificationExercise, verifyQualificationExercise } from './staging-qualification-exercise.mjs';
import { runQualificationLifecycle } from './staging-qualification-lifecycle.mjs';
import { accessFixture } from './staging-qualification-access.test.mjs';
import { fileFixture } from './staging-qualification-files.test.mjs';
import { transferFixture } from './staging-qualification-app-transfer.test.mjs';
import { deletionFixture } from './staging-qualification-deletion.test.mjs';

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
  copyFileSync(new URL('../wrangler.staging.json', import.meta.url), join(dir, '../wrangler.staging.json'));
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
    GITHUB_WORKFLOW_SHA: sha,
    GITHUB_WORKFLOW_REF: 'TogetherWeOwn/qerith/.github/workflows/drive-staging-qualification.yml@refs/heads/main',
    GITHUB_RUN_ID: '182', GITHUB_RUN_ATTEMPT: '3', CLOUDFLARE_ACCOUNT_ID: '209cf7dd678adfb683947dd7874d05af',
    QERITH_S3_ENDPOINT: target, QERITH_S3_BUCKET: bucket,
    QERITH_S3_REGION: 'auto', QERITH_S3_STORAGE_EPOCH: 'fixture-epoch',
    QERITH_S3_ACCESS_KEY_ID: 'fixture-key', QERITH_S3_SECRET_ACCESS_KEY: 'fixture-secret' };
  return { cwd, git, env, context: { sha, prefix, runId: '182', attempt: '3' } };
}

test('protected settings must match the committed staging target and reviewed R2 identity', async t => {
  const { cwd, env } = job(t);
  // The gate must read both files from the committed SHA, not the working tree.
  writeFileSync(join(cwd, 'apps/drive/wrangler.staging.json'), '{}');
  writeFileSync(join(cwd, 'apps/drive/scripts/staging-storage-qualification.json'), '{}');
  await assertQualificationSettings(env, cwd);
  for (const override of [{ CLOUDFLARE_ACCOUNT_ID: '' }, { CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) },
    { QERITH_S3_STORAGE_EPOCH: 'other' }, { QERITH_S3_BUCKET: 'other-bucket' }, { QERITH_S3_ACCESS_KEY_ID: 'other-key' },
    { QERITH_S3_SECRET_ACCESS_KEY: '' }]) {
    await assert.rejects(assertQualificationSettings({ ...env, ...override }, cwd), /reviewed storage binding is unverified/);
  }
  const nonR2 = job(t, 'https://storage.example.test');
  await assert.rejects(assertQualificationSettings(nonR2.env, nonR2.cwd), /reviewed storage binding is unverified/);

  // Match the protected workflow's plain Node invocation, without the test loader or credential environment.
  const cli = fileURLToPath(new URL('./staging-qualification-settings.mjs', import.meta.url));
  const run = overrides => {
    const { error, status, stdout, stderr } = spawnSync(process.execPath, [cli], {
      cwd, env: { PATH: process.env.PATH, ...env, ...overrides }, encoding: 'utf8', timeout: 30_000
    });
    assert.ifError(error);
    return { status, stdout, stderr };
  };
  assert.deepEqual(run(), { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(run({ QERITH_S3_BUCKET: 'other-bucket' }), {
    status: 1, stdout: '', stderr: 'Protected staging target or reviewed storage binding is unverified.\n'
  });
});

test('composed cases require exact attempt and fail closed on unobserved access', async t => {
  const { cwd, env, context } = job(t);
  const active = { ...context, version: '11111111-1111-1111-1111-111111111111' };
  const trace = [];
  const adapters = Object.fromEntries(['readFileFixtures', 'openTransferClient', 'openDeletion', 'send']
    .map(name => [name, () => trace.push(name)]));
  adapters.withAccessFixtures = (identity, signal) => {
    trace.push({ identity, aborted: signal.aborted });
    return { 'passkey-positive': 'pass' }; // Not observed through the access checker.
  };
  await assert.rejects(createQualificationExercise(env, cwd, { ...adapters, openDeletion: undefined }), /adapters/);
  await assert.rejects(createQualificationExercise({ ...env, QERITH_S3_BUCKET: 'other' }, cwd, adapters), /S3 cases are unverified/);
  const run = await createQualificationExercise(env, cwd, adapters);
  const { signal } = new AbortController();
  for (const override of [{ sha: 'a'.repeat(40) }, { runId: '184' }, { attempt: '4' }, { prefix: 'drive-qualification/' }, { version: '' }]) {
    await assert.rejects(run({ ...active, ...override }, signal), /\(scope\)/);
  }
  await assert.rejects(run(active, AbortSignal.abort()), /\(scope\)/);
  assert.deepEqual(trace, []);
  await assert.rejects(run(active, signal), /\(access\)/);
  await assert.rejects(run(active, signal), /\(scope\)/);
  assert.deepEqual(trace, [{ identity: active, aborted: false }]);
});

const r2Account = new URL(endpoint).hostname.split('.')[0];
const objectAge = 3 * 86400;
const uploadAge = 7 * 86400;
const transition = maxAge => ({ condition: { type: 'Age', maxAge } });
const expiryRule = (prefix, extra) => ({ enabled: true, conditions: { prefix }, ...extra });
const objects = expiryRule('drive-qualification/', { deleteObjectsTransition: transition(objectAge) });
const uploads = expiryRule('', { abortMultipartUploadsTransition: transition(uploadAge) });
const expiryPayload = rules => ({ success: true, errors: [], result: { rules } });

function expiryFixture(t) {
  const { cwd, env } = job(t);
  env.CLOUDFLARE_API_TOKEN = 'fixture-api-token';
  const urls = [];
  const verify = ({ overrides, signal, rules = [objects, uploads], respond = () => Response.json(expiryPayload(rules)) } = {}) =>
    verifyQualificationR2Expiry({ ...env, ...overrides }, cwd, signal, async (url, init) => {
      urls.push(url);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.authorization, 'Bearer fixture-api-token');
      assert.equal(init.headers['cf-r2-jurisdiction'], 'default');
      assert.equal(init.signal.aborted, false);
      return respond(init.signal);
    });
  return { verify, urls, cwd };
}

test('native R2 expiry reads only the reviewed bucket and covers both fixture types', async t => {
  const { verify, urls, cwd } = expiryFixture(t);
  writeFileSync(join(cwd, 'apps/drive/scripts/staging-storage-qualification.json'), '{}');
  const rules = [objects, uploads, expiryRule('unrelated/', { deleteObjectsTransition: transition(objectAge + 1) })];
  assert.equal(await verify({ rules }), true);
  assert.deepEqual(urls, [`https://api.cloudflare.com/client/v4/accounts/${r2Account}/r2/buckets/${bucket}/lifecycle`]);
  for (const overrides of [{ QERITH_S3_BUCKET: 'another-bucket' }, { GITHUB_RUN_ATTEMPT: '0' },
    { CLOUDFLARE_API_TOKEN: '' }, { GITHUB_JOB: 'preview' }]) {
    await assert.rejects(verify({ overrides }), /expiry is unverified/);
  }
  await assert.rejects(verify({ signal: AbortSignal.abort() }), /expiry is unverified/);
  assert.equal(urls.length, 1);
});

test('native R2 expiry rejects missing, partial, conflicting and non-age coverage', async t => {
  const { verify } = expiryFixture(t);
  for (const rules of [[], [objects], [uploads], [{ ...objects, enabled: false }, uploads],
    [expiryRule('', { deleteObjectsTransition: transition(objectAge) }), uploads],
    [expiryRule(`${prefix}partial/`, { deleteObjectsTransition: transition(objectAge) }), uploads],
    [objects, expiryRule('drive-qualification/full-v0/182/30/', { abortMultipartUploadsTransition: transition(uploadAge) })],
    [objects, uploads, expiryRule(`${prefix}narrower/`, { deleteObjectsTransition: transition(objectAge + 1) })],
    [objects, uploads, expiryRule(prefix, { abortMultipartUploadsTransition: transition(uploadAge + 1) })],
    [objects, uploads, expiryRule(prefix, { deleteObjectsTransition: { condition: { type: 'Date', date: '2026-12-01' } } })],
    [objects, uploads, { ...objects, conditions: { prefix, unknownFilter: true } }]]) {
    await assert.rejects(verify({ rules }), /expiry is unverified/);
  }
});

test('native R2 expiry rejects provider errors, excessive bodies and cancellation without diagnostics', async t => {
  const { verify, urls } = expiryFixture(t);
  const controller = new AbortController();
  const payload = expiryPayload([objects, uploads]);
  for (const respond of [() => new Response('private diagnostic', { status: 403 }),
    () => Response.json({ ...payload, errors: ['private diagnostic'] }),
    () => new Response(' '.repeat(65_537) + JSON.stringify(payload)),
    () => { controller.abort(new Error('private diagnostic')); return Response.json(payload); }]) {
    await assert.rejects(verify({ respond, signal: controller.signal }), { message: 'Qualification R2 native expiry is unverified.' });
  }
  assert.equal(urls.length, 4);
  assert.equal(controller.signal.aborted, true);
});

test('native R2 expiry rejects cancellation while reading a stalled response body', { timeout: 5000 }, async t => {
  const { verify } = expiryFixture(t);
  const controller = new AbortController();
  const stalled = Promise.withResolvers();
  let sentChunk = false;
  const respond = active => new Response(new ReadableStream({
    start(body) {
      // Like fetch, the transport errors a pending body read on request abort.
      active.addEventListener('abort', () => body.error(active.reason), { once: true });
    },
    pull(body) {
      if (sentChunk) {
        stalled.resolve();
      } else {
        sentChunk = true;
        body.enqueue(new TextEncoder().encode('{"success":true,'));
      }
    },
  }, { highWaterMark: 0 }));
  const rejected = assert.rejects(verify({ respond, signal: controller.signal }),
    { message: 'Qualification R2 native expiry is unverified.' });
  await stalled.promise;
  controller.abort(new Error('private diagnostic'));
  await rejected;
});

function signedFixture({ postPrefix = prefix, count = '1', proofBucket = bucket, postPendingPrefix = prefix,
  initialUploadsXml = '', finalUploadsXml = '', finalObjectsXml = '', listedKey = key, namespaced = false } = {}) {
  const namespace = namespaced ? ' xmlns="http://s3.amazonaws.com/doc/2006-03-01/"' : '';
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
        const record = pending && !initialUploadsXml ? `<Upload><Key>${encodeURIComponent(listedKey)}</Key><UploadId>${uploadId}</UploadId></Upload>` : '';
        const extra = pending ? initialUploadsXml : finalUploadsXml;
        return new Response(`<ListMultipartUploadsResult${namespace}><Bucket>${bucket}</Bucket>${envelope(pending ? prefix : postPendingPrefix)}${record}${extra}</ListMultipartUploadsResult>`);
      }
      assert.equal(url.searchParams.get('list-type'), '2');
      const record = present ? `<Contents><Key>${encodeURIComponent(listedKey)}</Key></Contents>` : '';
      return new Response(`<ListBucketResult${namespace}><Name>${proofBucket}</Name>${envelope(present ? prefix : postPrefix)}<KeyCount>${present ? count : 0}</KeyCount>${record}${present ? '' : finalObjectsXml}</ListBucketResult>`);
    }
    assert.equal(request.method, 'DELETE');
    assert.equal(decodeURIComponent(url.pathname), `/${bucket}/${listedKey}`);
    if (url.searchParams.has('uploadId')) {
      assert.equal(url.searchParams.get('uploadId'), uploadId);
      pending = false;
    } else present = false;
    return new Response(null, { status: 204 });
  };
  return { send, trace };
}

test('the protected R2 adapter rejects unverified bindings before sending requests', async t => {
  const { cwd, env } = job(t);
  const { send, trace } = signedFixture();
  await assert.rejects(createQualificationR2Cleanup({ ...env, QERITH_S3_BUCKET: 'other-bucket' }, cwd, { send }), /cleanup is unverified/);
  await assert.rejects(createQualificationR2Cleanup({ ...env, GITHUB_JOB: 'preview' }, cwd, { send }), /protected staging/);
  const nonNativeProvider = job(t, 'https://storage.example.test');
  await assert.rejects(createQualificationR2Cleanup(nonNativeProvider.env, nonNativeProvider.cwd, { send }), /cleanup is unverified/);
  assert.deepEqual(trace, []);
});

test('the protected R2 adapter signs and scopes every request with a reviewed binding', async t => {
  const { cwd, env, context } = job(t);
  const { send, trace } = signedFixture();
  const cleanup = await createQualificationR2Cleanup(env, cwd, { send });
  assert.throws(() => cleanup({ ...context, sha: 'f'.repeat(40) }), /cleanup is unverified/);
  assert.deepEqual(trace, []);
  assert.equal(await cleanup(context), true);
  assert.deepEqual(trace, ['GET', 'GET', 'DELETE', 'DELETE', 'GET', 'GET']);
});

test('signed recovery uses the source commit and requires a byte-identical GET after create', async t => {
  const { cwd, git, env, context } = job(t);
  writeFileSync(join(cwd, 'apps/drive/scripts/staging-storage-qualification.json'), '{}');
  git('commit', '-qam', 'new head without a reviewed storage binding');
  const head = git('rev-parse', 'HEAD');
  env.GITHUB_SHA = env.TESTED_SHA = head;
  env.CLOUDFLARE_API_TOKEN = 'fixture-api-token';
  const { sha, runId, attempt } = context;
  const record = { kind: 'd1', ...context, bookmark: 'offline_bookmark' };
  const canonical = Buffer.from(JSON.stringify({ schema: 'drive-staging-recovery.v1', kind: 'd1',
    sha, runId, attempt, bookmark: record.bookmark }));
  const objectURL = `${endpoint}/${bucket}/drive-qualification/recovery/drive-staging-recovery-d1-${sha}-run-${runId}-attempt-${attempt}`;
  const lifecycleURL = `https://api.cloudflare.com/client/v4/accounts/${r2Account}/r2/buckets/${bucket}/lifecycle`;

  const deniedPolicies = ['missing retention', 'partial status', 'content range', 'paginated policy'];
  for (const outcome of ['verified', 'readback drift', 'oversized readback', 'lost acknowledgement', ...deniedPolicies]) {
    await t.test(outcome, async () => {
      const trace = [];
      let stored, fixtureError, streamCancelled;
      const canWrite = !deniedPolicies.includes(outcome);
      const lostAcknowledgement = new Error('fixture lost the acknowledgement after storing bytes');
      const respond = async (request, init) => {
        if (typeof request === 'string') {
          trace.push('lifecycle');
          assert.equal(request, lifecycleURL);
          assert.equal(init.method, 'GET');
          assert.equal(init.headers.authorization, 'Bearer fixture-api-token');
          const policy = expiryPayload(outcome === 'missing retention' ? [] : [objects]);
          if (outcome === 'paginated policy') policy.result_info = { cursor: 'next' };
          return Response.json(policy, { status: outcome === 'partial status' ? 206 : 200,
            headers: outcome === 'content range' ? { 'content-range': 'bytes 0-255/512' } : {} });
        }
        trace.push(request.method);
        assert.equal(request.url, objectURL);
        assert.equal(request.redirect, 'manual');
        const authorization = request.headers.get('authorization');
        assert.match(authorization, /^AWS4-HMAC-SHA256 Credential=fixture-key\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=/);
        if (request.method === 'PUT') {
          assert.equal(request.headers.get('if-none-match'), '*');
          assert.match(authorization.split('SignedHeaders=')[1].split(',')[0], /(?:^|;)if-none-match(?:;|$)/);
          assert.equal(request.headers.get('x-amz-content-sha256'), createHash('sha256').update(canonical).digest('hex'));
          stored = Buffer.from(await request.arrayBuffer());
          if (outcome === 'lost acknowledgement') throw lostAcknowledgement;
          return new Response(null, { headers: { etag: '"created"' } });
        }
        assert.equal(request.headers.get('cache-control'), 'no-cache, no-store');
        const date = new Date(Date.now() + 1000).toUTCString();
        if (outcome === 'oversized readback') {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(2048));
              controller.enqueue(Uint8Array.of(1));
            },
            cancel(reason) { streamCancelled = reason; },
          }), { headers: { date, 'last-modified': date } });
        }
        const bytes = outcome === 'readback drift' ? Buffer.concat([stored, Buffer.from('\n')]) : stored;
        return new Response(bytes, { headers: { date, 'last-modified': date, 'content-length': bytes.length } });
      };
      const send = (...args) => respond(...args).catch(error => {
        // Production masks transport errors; don't let it mask a broken fixture.
        if (error !== lostAcknowledgement) fixtureError ??= error;
        throw error;
      });
      await assert.rejects(createQualificationR2RecoveryStore({ sha: head, runId, attempt }, env, cwd, { send }),
        /recovery storage is unverified/);
      assert.deepEqual(trace, []);
      const store = await createQualificationR2RecoveryStore(context, env, cwd, { send });
      const write = qualificationRecoveryWriter(context, store);
      try {
        if (outcome === 'verified') assert.equal(await write(record), true);
        else await assert.rejects(write(record), { message: 'Staging qualification recovery record is unverified.' });
      } finally {
        assert.ifError(fixtureError);
        assert.deepEqual(trace, canWrite ? ['lifecycle', 'PUT', ...(outcome === 'lost acknowledgement' ? [] : ['GET'])] : ['lifecycle']);
      }
      assert.deepEqual(stored, canWrite ? canonical : undefined);
      if (outcome === 'oversized readback') assert.equal(streamCancelled?.message, 'S3 response exceeds limit');
    });
  }
});

function storageFixture() {
  const key = `${prefix}provider-multipart-fixture`;
  const split = 5 * 1024 * 1024;
  const whole = Buffer.concat([Buffer.alloc(split, 0x35), Buffer.alloc(257, 0x9a)]);
  whole.set([0x12, 0x34, 0x56, 0x78], split - 2);
  const tag = '"stored"';
  const trace = [];
  const send = async request => {
    const url = new URL(request.url);
    assert.equal(url.origin, endpoint);
    assert.equal(url.pathname, `/${bucket}/${key}`);
    assert.match(request.headers.get('authorization'), /^AWS4-HMAC-SHA256 /);
    assert.equal(request.redirect, 'manual');
    const query = url.searchParams;
    const op = trace.length;
    trace.push(request.method);
    if (op === 0) return new Response(null, { status: 404 });
    if (op === 1) {
      assert.ok(query.has('uploads'));
      return new Response(`<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (op <= 9) assert.equal(query.get('uploadId'), uploadId);
    if (op === 2 || (op >= 4 && op <= 6)) {
      const last = op === 6;
      assert.equal(query.get('partNumber'), last ? '2' : '1');
      const bytes = Buffer.from(await request.arrayBuffer());
      assert.deepEqual(bytes, op === 2 ? Buffer.alloc(split, 0x71) : last ? whole.subarray(split) : whole.subarray(0, split));
      return new Response(null, { headers: { etag: op === 2 ? '"seed"' : last ? '"last"' : '"replacement"' } });
    }
    if (op === 3 || op === 7 || op === 8) {
      const last = op === 8, truncated = op === 7;
      assert.equal(query.get('part-number-marker'), last ? '1' : null);
      assert.equal(query.get('max-parts'), '1');
      return new Response(`<ListPartsResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId>` +
        `<IsTruncated>${truncated}</IsTruncated>${truncated ? '<NextPartNumberMarker>1</NextPartNumberMarker>' : last ? '<PartNumberMarker>1</PartNumberMarker>' : ''}` +
        `<Part><PartNumber>${last ? 2 : 1}</PartNumber><ETag>"${op === 3 ? 'seed' : last ? 'last' : 'replacement'}"</ETag>` +
        `<Size>${last ? 257 : split}</Size></Part></ListPartsResult>`);
    }
    if (op === 9) {
      assert.equal(request.headers.get('if-none-match'), '*');
      const manifest = await request.text();
      assert.match(manifest, /replacement.*last/);
      assert.doesNotMatch(manifest, /seed/);
      return new Response(`<CompleteMultipartUploadResult><ETag>${tag}</ETag></CompleteMultipartUploadResult>`);
    }
    assert.equal(request.headers.get('if-match'), tag);
    if (op === 10) return new Response(null, { headers: { etag: tag, 'content-length': String(whole.length) } });
    const ranged = op === 12;
    assert.equal(request.headers.get('range'), ranged ? `bytes=${split - 2}-${split + 1}` : null);
    const bytes = ranged ? whole.subarray(split - 2, split + 2) : whole;
    return new Response(bytes, { status: ranged ? 206 : 200, headers: { etag: tag, 'content-length': String(bytes.length),
      ...(ranged && { 'content-range': `bytes ${split - 2}-${split + 1}/${whole.length}` }) } });
  };
  return { send, trace };
}

const storageCalls = ['HEAD', 'POST', 'PUT', 'GET', 'PUT', 'PUT', 'PUT', 'GET', 'GET', 'POST', 'HEAD', 'GET', 'GET'];

test('storage cases use signed calls against only the reviewed bucket and attempt key', async t => {
  const { cwd, env, context } = job(t);
  const { send, trace } = storageFixture();
  const exercise = await createQualificationStorageCases(env, cwd, { send });
  assert.throws(() => exercise({ ...context, runId: '183' }), /cases are unverified/);
  assert.deepEqual(trace, []);
  assert.deepEqual(await exercise(context), { 's3-multipart': 'pass', 's3-range': 'pass', 's3-retry': 'pass', 's3-persistence': 'pass' });
  assert.deepEqual(trace, storageCalls);
});

test('lifecycle runs all 19 cases for one candidate and rejects replay of that evidence', { timeout: 90_000 }, async t => {
  const { cwd, env, context } = job(t);
  const active = { ...context, version: '11111111-1111-1111-1111-111111111111' };
  const binding = { endpoint, bucket, epoch: env.QERITH_S3_STORAGE_EPOCH };
  const access = accessFixture(undefined, active);
  const files = fileFixture(undefined, prefix);
  const storage = storageFixture();
  const large = transferFixture({ scope: active }), resume = transferFixture({ scope: active, resume: true });
  const { io, trees } = deletionFixture({ scope: binding, prefix });
  const phases = [];
  let scopeReads = 0, clients = 0;
  Object.defineProperty(io, 'scope', { get: () => ++scopeReads === 1 ? binding : { ...binding, bucket: 'different' } });
  const compose = await createQualificationExercise(env, cwd, {
    withAccessFixtures: access.withFixtures,
    readFileFixtures(scope) { assert.deepEqual(scope, active); return files; },
    send: storage.send,
    openTransferClient: (...args) => (++clients === 1 ? large : resume).openClient(...args),
    openDeletion(scope, reviewed) {
      assert.deepEqual(scope, active);
      assert.deepEqual(reviewed, binding);
      assert.ok(Object.isFrozen(reviewed));
      return io;
    },
  });
  const signal = new AbortController().signal;
  const run = exercise => runQualificationLifecycle({ exercise, assertFullV0: () => true, recordRecovery: () => true,
    inventory({ phase }) { phases.push(phase); return true; },
    cleanup(scope) { assert.deepEqual(scope, active); phases.push('cleanup'); return true; },
  }, env, cwd, signal, {
    upload: () => active, migrate: () => null,
    async worker({ upload, exercise, cleanup }, _env, _cwd, workerSignal) {
      try { return await exercise(upload, workerSignal); }
      finally { await cleanup(upload, workerSignal); phases.push('restore'); }
    },
  });
  const { deployment: cases } = await run(async (invocation, phaseSignal) => {
    const evidence = await compose(invocation, phaseSignal);
    assert.throws(() => verifyQualificationExercise(evidence, { ...invocation }, phaseSignal), /case evidence/);
    assert.throws(() => verifyQualificationExercise(evidence, invocation, new AbortController().signal), /case evidence/);
    return evidence;
  });
  const expected = [
    'passkey-positive', 'passkey-negative', 'invite-acceptance', 'member-revocation', 'cross-user-denial',
    'unauthenticated-file-denial', 'authenticated-file-access', 'folder-operations', 'share-and-revoke',
    's3-multipart', 's3-range', 's3-retry', 's3-persistence', 'large-transfer-hash', 'interrupted-transfer-resume',
    'delete-envelope', 'delete-boundary-and-safe-fallback', 'delete-rollback-and-retry', 'delete-provider-proof',
  ];
  assert.deepEqual(cases, Object.fromEntries(expected.map(name => [name, 'pass'])));
  assert.deepEqual(access.transcript, []);
  assert.deepEqual(storage.trace, storageCalls);
  assert.deepEqual([large.clients, resume.clients, scopeReads, trees.size], [1, 2, 1, 8]);
  const lifecycleOrder = ['before', 'cleanup', 'restore', 'after'];
  assert.deepEqual(phases, lifecycleOrder);
  // Even the same SHA/version/attempt cannot reuse evidence from an earlier invocation.
  await assert.rejects(run(() => cases), /case evidence/);
  assert.deepEqual(phases, [...lifecycleOrder, ...lifecycleOrder]);
});

test('signed R2 cleanup includes a key exactly equal to the attempt prefix', async t => {
  const { cwd, env, context } = job(t);
  const { send, trace } = signedFixture({ listedKey: prefix, namespaced: true,
    finalUploadsXml: '<KeyMarker/><UploadIdMarker/><NextKeyMarker/><NextUploadIdMarker/>' });
  const cleanup = await createQualificationR2Cleanup(env, cwd, { send });
  assert.equal(await cleanup(context), true);
  assert.deepEqual(trace, ['GET', 'GET', 'DELETE', 'DELETE', 'GET', 'GET']);
});

test('signed R2 cleanup rejects a skipped start or contradictory multipart continuation', async t => {
  const { cwd, env, context } = job(t);
  const deleted = ['GET', 'GET', 'DELETE', 'DELETE'];
  for (const [field, xml, checks] of [
    ['finalObjectsXml', '<StartAfter>later</StartAfter>', ['GET', 'GET']],
    ['finalObjectsXml', '<ContinuationToken>later</ContinuationToken>', ['GET', 'GET']],
    ['finalObjectsXml', '<Delimiter>%2F</Delimiter>', ['GET', 'GET']],
    ['finalUploadsXml', '<KeyMarker>later</KeyMarker>', ['GET']],
    ['finalUploadsXml', '<UploadIdMarker>later</UploadIdMarker>', ['GET']],
    ['finalUploadsXml', '<NextKeyMarker>later</NextKeyMarker>', ['GET']],
    ['finalUploadsXml', '<NextUploadIdMarker>later</NextUploadIdMarker>', ['GET']],
  ]) {
    const { send, trace } = signedFixture({ [field]: xml });
    const cleanup = await createQualificationR2Cleanup(env, cwd, { send });
    await assert.rejects(cleanup(context), /cleanup is unverified/, xml);
    assert.deepEqual(trace, [...deleted, ...checks]);
  }
});

test('signed R2 cleanup rejects wrong namespaces in listing prechecks and readbacks', async t => {
  const { cwd, env, context } = job(t);
  const wrongNamespace = 'xmlns="urn:fixture"';
  const upload = `<Upload ${wrongNamespace}><Key>${encodeURIComponent(key)}</Key><UploadId>${uploadId}</UploadId></Upload>`;
  const grouped = `<CommonPrefixes ${wrongNamespace}><Prefix>${encodeURIComponent(prefix)}</Prefix></CommonPrefixes>`;
  const deleted = ['GET', 'GET', 'DELETE', 'DELETE'];
  for (const [field, xml, expected] of [
    ['initialUploadsXml', upload, ['GET']],
    ['initialUploadsXml', grouped, ['GET']],
    ['finalUploadsXml', upload, [...deleted, 'GET']],
    ['finalUploadsXml', grouped, [...deleted, 'GET']],
    ['finalUploadsXml', `<Bucket ${wrongNamespace}>${bucket}</Bucket>`, [...deleted, 'GET']],
    ['finalUploadsXml', `<KeyMarker ${wrongNamespace}>later</KeyMarker>`, [...deleted, 'GET']],
    ['finalObjectsXml', `<Contents ${wrongNamespace}><Key>${encodeURIComponent(key)}</Key></Contents>`, [...deleted, 'GET', 'GET']],
    ['finalObjectsXml', '<NextContinuationToken xmlns="">later</NextContinuationToken>', [...deleted, 'GET', 'GET']],
  ]) {
    await t.test(`${field}: ${xml.slice(1, xml.indexOf(' '))}`, async () => {
      const { send, trace } = signedFixture({ [field]: xml, namespaced: true });
      const cleanup = await createQualificationR2Cleanup(env, cwd, { send });
      await assert.rejects(cleanup(context), /cleanup is unverified/);
      assert.deepEqual(trace, expected);
    });
  }
});

test('signed R2 cleanup rejects scope and enumeration mismatches', async t => {
  const { cwd, env, context } = job(t);
  const grouped = `<CommonPrefixes><Prefix>${encodeURIComponent(`${prefix}hidden/`)}</Prefix></CommonPrefixes>`;
  for (const [options, expected] of [
    [{ initialUploadsXml: grouped }, ['GET']],
    [{ finalUploadsXml: grouped }, ['GET', 'GET', 'DELETE', 'DELETE', 'GET']],
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
