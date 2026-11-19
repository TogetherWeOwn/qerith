import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadStorageEvidence } from '../src/lib/server/metadata/upload-storage-evidence';
import { downloadStorage } from '../src/lib/server/published-download';
import { wireUploadStorage } from '../src/lib/server/storage-runtime';
import { uploadRoutes, type UploadRouteEnv } from '../src/lib/server/upload-routes';

const storage = {
  DRIVE_S3_ENDPOINT: 'https://storage.example.test/',
  DRIVE_S3_BUCKET: 'drive-staging',
  DRIVE_S3_REGION: 'us-east-1',
  DRIVE_S3_ACCESS_KEY_ID: 'synthetic-key',
  DRIVE_S3_SECRET_ACCESS_KEY: 'synthetic-secret',
  DRIVE_S3_STORAGE_EPOCH: 'first'
};
const storageConfigId = JSON.stringify(['https://storage.example.test', 'drive-staging', 'first']);
const proof = { version: 1, storageConfigId, region: 'us-east-1', sourceSha: 'a'.repeat(40), runId: '123',
  runAttempt: 1, completionTimeoutMs: 928 };
const db = { withSession() { assert.fail('unexpected D1 access'); } } as NonNullable<UploadRouteEnv['DB']>;
const origin = 'https://drive.example.test';
const noFetch: typeof fetch = async () => assert.fail('unexpected storage access');

function bindings(evidence = proof) {
  return { ...storage, DB: db, DRIVE_ORIGIN: origin, DRIVE_S3_QUALIFICATION: JSON.stringify(evidence) };
}

test('upload and download derive the same storage identity and configuration', async () => {
  const env = bindings();
  const upload = wireUploadStorage(env, noFetch);
  const read = downloadStorage(env)!;
  assert.deepEqual(upload.DRIVE_UPLOAD_S3, read.config);
  assert.equal(read.storageConfigId, storageConfigId);
  assert.equal(uploadStorageEvidence(upload.DRIVE_UPLOAD_S3!, upload.DRIVE_UPLOAD_EPOCH!).storageConfigId, read.storageConfigId);
  assert.equal(await upload.DRIVE_UPLOAD_VERIFIER!.isQualified(storageConfigId), true);
  assert.equal(upload.DRIVE_UPLOAD_VERIFIER!.completionTimeoutMs(storageConfigId), 928);
  assert.equal(await upload.DRIVE_UPLOAD_VERIFIER!.isQualified('wrong'), false);
  assert.equal(upload.DRIVE_UPLOAD_VERIFIER!.completionTimeoutMs('wrong'), null);
  const invalid = { ...env, DRIVE_S3_ENDPOINT: 'http://storage.example.test' };
  assert.equal(wireUploadStorage(invalid, noFetch).DRIVE_UPLOAD_S3, undefined);
  assert.equal(downloadStorage(invalid), null);
});

test('unqualified uploads stay unavailable without touching D1 or storage', async () => {
  const session = { token: 'x'.repeat(43), principal: { id: 'owner' } } as NonNullable<App.Locals['driveSession']>;
  const id = 'd6d78692-fad5-4d93-af26-5cfcbed5a586';
  for (const env of [{ ...bindings(), DRIVE_S3_QUALIFICATION: undefined },
    { ...bindings(), DRIVE_S3_QUALIFICATION: '{' }, { ...bindings(), DRIVE_S3_STORAGE_EPOCH: 'second' },
    { ...bindings(), DRIVE_S3_REGION: 'us-west-2' }, bindings({ ...proof, sourceSha: '' }),
    bindings({ ...proof, completionTimeoutMs: 0 }), bindings({ ...proof, completionTimeoutMs: 60_001 })]) {
    const runtime = wireUploadStorage(env, noFetch);
    assert.equal(runtime.DRIVE_UPLOAD_VERIFIER, undefined);
    const routes = uploadRoutes(runtime, { fetch: noFetch, timeoutMs: 5000 });
    assert.equal((await routes.part(new Request(origin, { method: 'PUT', headers: { origin } }), session, id, '1')).status, 503);
    assert.equal((await routes.complete(new Request(origin, { method: 'POST', headers: { origin } }), session, id)).status, 503);
  }
});

test('verification uses signed ListParts on the exact key and upload ID across pages', async () => {
  const markers: Array<string | null> = [];
  const verifier = wireUploadStorage(bindings(), async input => {
    assert.ok(input instanceof Request);
    const url = new URL(input.url);
    assert.equal(input.method, 'GET');
    assert.equal(input.redirect, 'manual');
    assert.ok(input.headers.has('authorization'));
    assert.equal(url.origin + url.pathname, 'https://storage.example.test/drive-staging/key%20one');
    assert.equal(url.searchParams.get('uploadId'), 'opaque+/=');
    markers.push(url.searchParams.get('part-number-marker'));
    const number = markers.length;
    return new Response(`<ListPartsResult><IsTruncated>${number === 1}</IsTruncated>` +
      (number === 1 ? '<NextPartNumberMarker>1</NextPartNumberMarker>' : '') +
      `<Part><PartNumber>${number}</PartNumber><ETag>"tag-${number}"</ETag><Size>${number * 47}</Size></Part></ListPartsResult>`);
  }).DRIVE_UPLOAD_VERIFIER!;
  const upload = { storageConfigId, operationId: 'op', intentId: 'intent', ownerId: 'owner', objectKey: 'key one',
    uploadId: 'opaque+/=', intentVersion: 1 };
  assert.equal(await verifier.verifyParts({ ...upload, storageConfigId: 'wrong' }), null);
  assert.deepEqual(markers, []);
  assert.deepEqual(await verifier.verifyParts(upload), [
    { partNumber: 1, size: 47, etag: '"tag-1"' }, { partNumber: 2, size: 94, etag: '"tag-2"' }
  ]);
  assert.deepEqual(markers, [null, '1']);
  const invalid = wireUploadStorage(bindings(), async () => new Response('<ListPartsResult/>')).DRIVE_UPLOAD_VERIFIER!;
  assert.equal(await invalid.verifyParts(upload), null);
});
