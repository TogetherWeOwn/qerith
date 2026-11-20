import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createQualificationR2Cleanup } from './staging-qualification-cleanup.mjs';
import { verifyQualificationR2Expiry } from './staging-qualification-expiry.mjs';
import { createQualificationStorageCases } from './staging-qualification-storage-cases.mjs';

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

test('storage cases use signed calls against only the reviewed bucket and attempt key', async t => {
  const { cwd, env, context } = job(t);
  const key = `${prefix}provider-multipart-fixture`;
  const split = 5 * 1024 * 1024;
  const whole = Buffer.concat([Buffer.alloc(split, 0x35), Buffer.alloc(257, 0x9a)]);
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
    if (op < 9) assert.equal(query.get('uploadId'), uploadId);
    if (op <= 5) {
      assert.equal(query.get('partNumber'), op === 5 ? '2' : '1');
      const bytes = Buffer.from(await request.arrayBuffer());
      assert.deepEqual(bytes, op === 2 ? Buffer.alloc(split, 0x71) : op < 5 ? whole.subarray(0, split) : whole.subarray(split));
      return new Response(null, { headers: { etag: `"p${op === 4 ? 3 : op}"` } });
    }
    if (op <= 7) {
      const first = op === 6;
      assert.equal(query.get('part-number-marker'), first ? null : '1');
      assert.equal(query.get('max-parts'), '1');
      return new Response(`<ListPartsResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId>` +
        `<IsTruncated>${first}</IsTruncated>${first ? '<NextPartNumberMarker>1</NextPartNumberMarker>' : '<PartNumberMarker>1</PartNumberMarker>'}` +
        `<Part><PartNumber>${first ? 1 : 2}</PartNumber><ETag>"p${first ? 3 : 5}"</ETag><Size>${first ? split : 257}</Size></Part></ListPartsResult>`);
    }
    if (op === 8) {
      assert.equal(request.headers.get('if-none-match'), '*');
      const manifest = await request.text();
      assert.match(manifest, /p3.*p5/);
      assert.doesNotMatch(manifest, /p2/);
      return new Response(`<CompleteMultipartUploadResult><ETag>${tag}</ETag></CompleteMultipartUploadResult>`);
    }
    assert.equal(request.headers.get('if-match'), tag);
    if (op === 9) return new Response(null, { headers: { etag: tag, 'content-length': String(whole.length) } });
    const ranged = op === 11;
    assert.equal(request.headers.get('range'), ranged ? `bytes=${split - 2}-${split + 1}` : null);
    const bytes = ranged ? whole.subarray(split - 2, split + 2) : whole;
    return new Response(bytes, { status: ranged ? 206 : 200, headers: { etag: tag, 'content-length': String(bytes.length),
      ...(ranged && { 'content-range': `bytes ${split - 2}-${split + 1}/${whole.length}` }) } });
  };
  const exercise = await createQualificationStorageCases(env, cwd, { send });
  assert.throws(() => exercise({ ...context, runId: '183' }), /cases are unverified/);
  assert.deepEqual(trace, []);
  assert.deepEqual(await exercise(context), { 's3-multipart': 'pass', 's3-range': 'pass', 's3-retry': 'pass', 's3-persistence': 'pass' });
  assert.deepEqual(trace, ['HEAD', 'POST', 'PUT', 'PUT', 'PUT', 'PUT', 'GET', 'GET', 'POST', 'HEAD', 'GET', 'GET']);
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
