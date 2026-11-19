import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { proveStorage } from '../scripts/staging-storage-proof';
import { MIN_PART_BYTES } from '../src/lib/server/s3/multipart-completion';

const config = { endpoint: 'https://storage.example.test', bucket: 'staging-fixture', region: 'auto',
  accessKeyId: 'fake-key-id', secretAccessKey: 'fake-secret-key' };
const run = { sourceSha: 'b'.repeat(40), runId: '11', runAttempt: 2 };
const epoch = 'fixture-epoch';
const scope = { identitySha256: createHash('sha256').update(JSON.stringify([
  JSON.stringify([config.endpoint, config.bucket, epoch]), config.region, config.accessKeyId
])).digest('hex'), policySha256: 'c'.repeat(64) };
const key = 'drive-qualification/storage-proof/11/2/fixture';
const uploadId = 'fake:opaque/id';
const generation = '"completed-fixture"';

function provider(options: { denyList?: boolean; wrongSize?: boolean; badRange?: boolean; ambiguousCreate?: boolean; denyCleanup?: boolean } = {}) {
  const calls: string[] = [];
  const parts: ArrayBuffer[] = [];
  let exists = false, pending = false;
  const send: typeof fetch = async (input) => {
    assert.ok(input instanceof Request);
    const url = new URL(input.url), query = url.searchParams;
    assert.equal(url.origin, config.endpoint);
    assert.ok(input.headers.has('authorization'));
    const action = `${input.method} ${query.has('uploads') ? 'uploads' : query.has('partNumber') ? 'part' : query.has('uploadId') ? 'id' : 'object'}`;
    calls.push(action);
    const listUploads = action === 'GET uploads';
    assert.equal(url.pathname, `/${config.bucket}/${listUploads ? '' : key}`);
    if (query.has('uploadId')) assert.equal(query.get('uploadId'), uploadId);
    const bytes = Buffer.concat(parts.map((part) => Buffer.from(part)));
    const headers = { etag: generation, 'content-length': String(bytes.length) };
    if (action === 'HEAD object') return new Response(null, exists ? { headers } : { status: 404 });
    if (action === 'POST uploads') {
      pending = true;
      return options.ambiguousCreate ? new Response('private provider error', { status: 500 }) : new Response(
        `<InitiateMultipartUploadResult><Bucket>${config.bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (action === 'PUT part') {
      parts.push(await input.arrayBuffer());
      return new Response(null, { headers: { etag: `"part-${parts.length}"` } });
    }
    if (action === 'GET id') {
      if (options.denyList) return new Response(`private provider error: ${uploadId}`, { status: 403 });
      assert.equal(query.get('max-parts'), '1');
      const marker = query.get('part-number-marker') ?? '0';
      const number = Number(marker) + 1;
      const cursor = number === 1 ? '<NextPartNumberMarker>1</NextPartNumberMarker>' : '';
      return new Response(`<ListPartsResult><Bucket>${config.bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId>` +
        `<PartNumberMarker>${marker}</PartNumberMarker><IsTruncated>${number === 1}</IsTruncated>${cursor}` +
        `<Part><PartNumber>${number}</PartNumber><ETag>"part-${number}"</ETag>` +
        `<Size>${parts[number - 1].byteLength + Number(options.wrongSize ?? false)}</Size></Part></ListPartsResult>`);
    }
    if (action === 'POST id') {
      assert.equal(input.headers.get('if-none-match'), '*');
      assert.match(await input.text(), /<PartNumber>1<\/PartNumber>.*<PartNumber>2<\/PartNumber>/s);
      exists = true; pending = false;
      const stream = new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(' '));
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(`<CompleteMultipartUploadResult><ETag>${generation}</ETag></CompleteMultipartUploadResult>`));
          controller.close();
        }, 35);
      } });
      return new Response(stream);
    }
    if (action === 'GET object') {
      assert.equal(input.headers.get('if-match'), generation);
      if (!input.headers.has('range')) return new Response(bytes, { headers });
      assert.equal(input.headers.get('range'), `bytes=${MIN_PART_BYTES - 2}-${MIN_PART_BYTES + 1}`);
      return new Response(options.badRange ? Buffer.alloc(4) : bytes.subarray(MIN_PART_BYTES - 2, MIN_PART_BYTES + 2), {
        status: 206, headers: { ...headers, 'content-length': '4',
          'content-range': `bytes ${MIN_PART_BYTES - 2}-${MIN_PART_BYTES + 1}/${bytes.length}` }
      });
    }
    if (listUploads) {
      assert.equal(query.get('prefix'), 'drive-qualification/storage-proof/11/2/');
      const upload = pending ? `<Upload><Key>${key}</Key><UploadId>${uploadId}</UploadId></Upload>` : '';
      return new Response(`<ListMultipartUploadsResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated>${upload}</ListMultipartUploadsResult>`);
    }
    if (action === 'DELETE id') pending = false;
    else if (action === 'DELETE object') {
      if (options.denyCleanup) return new Response(null, { status: 403 });
      exists = false;
    } else assert.fail('Unexpected fixture operation');
    return new Response(null, { status: 204 });
  };
  return { calls, send };
}

test('uses signed paginated part evidence, measures through EOF, then checks and cleans the generation', async () => {
  const { calls, send } = provider();
  const proof = await proveStorage(config, epoch, run, scope, send);
  assert.ok(proof.passed);
  assert.deepEqual(proof.failures, []);
  assert.deepEqual(proof.parts.map(({ partNumber, size }) => [partNumber, size]), [[1, MIN_PART_BYTES], [2, 257]]);
  assert.equal(proof.pages, 2);
  assert.ok(proof.completionMs! >= 34);
  assert.ok(proof.completionTimeoutMs! >= 2 * proof.completionMs! + 1000);
  assert.equal(proof.fullBytes, MIN_PART_BYTES + 257);
  assert.equal(proof.rangeBytes, 4);
  assert.equal(proof.cleanup, 'verified');
  assert.equal(calls.filter((call) => call === 'POST id').length, 1);
  for (const privateValue of [config.endpoint, config.bucket, config.accessKeyId, config.secretAccessKey, uploadId, generation]) {
    assert.ok(!JSON.stringify(proof).includes(privateValue));
  }
});

test('does not contact storage with missing or stale signer scope', async () => {
  const { calls, send } = provider();
  for (const [storageEpoch, receipt] of [[epoch, null], ['changed-epoch', scope]] as const) {
    const proof = await proveStorage(config, storageEpoch, run, receipt, send);
    assert.equal(proof.passed, false);
    assert.deepEqual(proof.failures, [{ phase: 'reviewed-writer-scope' }]);
  }
  assert.deepEqual(calls, []);
});

test('denied or mismatched ListParts never reaches completion; an uncertain create is cleaned by prefix', async () => {
  for (const [problem, failure] of [
    [{ denyList: true }, { phase: 'list-parts', status: 403 }],
    [{ wrongSize: true }, { phase: 'list-parts', status: 200 }],
    [{ ambiguousCreate: true }, { phase: 'create-multipart', status: 500 }]
  ] as const) {
    const { calls, send } = provider(problem);
    const proof = await proveStorage(config, epoch, run, scope, send);
    assert.equal(proof.passed, false);
    assert.deepEqual(proof.failures, [failure]);
    assert.equal(proof.cleanup, 'verified');
    assert.ok(calls.includes('DELETE id'));
    assert.ok(!calls.includes('POST id'));
  }
});

test('range or cleanup failure keeps the final result closed', async () => {
  for (const [problem, phase, cleanup] of [
    [{ badRange: true }, 'verify-range-get', 'verified'],
    [{ denyCleanup: true }, 'cleanup-delete-object', 'unverified']
  ] as const) {
    const proof = await proveStorage(config, epoch, run, scope, provider(problem).send);
    assert.equal(proof.passed, false);
    assert.equal(proof.failures[0].phase, phase);
    assert.equal(proof.cleanup, cleanup);
  }
});

test('the protected manual workflow neither runs for PRs nor publishes staging', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/drive-staging-storage-proof.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\non:\n  workflow_dispatch:\n\npermissions:\n  contents: read/);
  assert.match(workflow, /group: drive-staging-lifecycle\n  cancel-in-progress: false/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'\n    environment: staging/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /drive-staging-storage-proof-\$\{\{ github.sha \}\}-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
  assert.doesNotMatch(workflow, /pull_request|wrangler|DRIVE_ORIGIN|DRIVE_SIGN_IN_FIXTURE/);
});
