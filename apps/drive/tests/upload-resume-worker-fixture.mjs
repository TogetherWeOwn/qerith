import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const endpoint = 'https://storage.example.test', bucket = 'fixture', epoch = 'resume-fixture';
const storage = {
  DRIVE_S3_ENDPOINT: `${endpoint}/`, DRIVE_S3_BUCKET: bucket, DRIVE_S3_REGION: 'test-1',
  DRIVE_S3_ACCESS_KEY_ID: 'fixture', DRIVE_S3_SECRET_ACCESS_KEY: 'fixture', DRIVE_S3_STORAGE_EPOCH: epoch,
  DRIVE_S3_QUALIFICATION: JSON.stringify({ version: 1, region: 'test-1', completionTimeoutMs: 5000,
    storageConfigId: JSON.stringify([endpoint, bucket, epoch]), sourceSha: 'a'.repeat(40), runId: '1', runAttempt: 1 })
};
export const uploadResumeWorker = `
import { uploadRoutes } from ${JSON.stringify(resolve('src/lib/server/upload-routes.ts'))};
import { wireUploadStorage } from ${JSON.stringify(resolve('src/lib/server/storage-runtime.ts'))};
function resumeRequest(request, env) {
  const raw = request.headers.has('x-test-resume-no-storage') ? env : { ...env, ...${JSON.stringify(storage)} };
  const fetch = () => { throw new Error('Resume must not access storage'); };
  const bindings = wireUploadStorage(raw, fetch);
  return uploadRoutes({ ...env, ...bindings }, { fetch, timeoutMs: 5000 }).resume(request);
}`;
export const uploadResumePath = id => `/api/uploads/${id}/resume`;

export async function exerciseUploadResume({ worker, DB, origin, session }) {
  const principalId = 'resume-member';
  const owner = await session(principalId, 'member');
  const other = await session('other-resume-member', 'member');
  const stale = await session('stale-resume-member', 'member');
  const sql = (query, ...values) => DB.prepare(query).bind(...values).run();
  const partBytes = 16 * 1024 * 1024, declaredSize = partBytes + 3;
  const allocate = async (storageEpoch = epoch, ownerId = principalId) => {
    const id = randomUUID(), key = `private-key-${id}`, uploadId = `provider-upload-${id}`;
    await sql(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size)
      VALUES (?, ?, ?, 'created', ?)`, id, ownerId, key, declaredSize);
    await sql('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)', id, endpoint, bucket, storageEpoch);
    await sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = 2 WHERE id = ?", uploadId, id);
    return { id, key, uploadId };
  };
  const { id, key, uploadId } = await allocate();
  const empty = (await allocate()).id;
  const wrongBinding = (await allocate('old-epoch')).id;
  const staleIntent = (await allocate(epoch, 'stale-resume-member')).id;
  const unallocated = randomUUID();
  await sql(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size)
    VALUES (?, ?, 'unallocated-resume-key', 'created', ?)`, unallocated, principalId, declaredSize);
  const ask = (path = uploadResumePath(id), cookie = owner, headers = {}, method = 'GET') =>
    worker.fetch(origin + path, { method, headers: { cookie, ...headers }, redirect: 'manual' });
  const denied = async (response, status) => assert.deepEqual(
    [response.status, response.headers.get('cache-control'), await response.text()], [status, 'private, no-store', '']);

  const parts = [];
  for (const [partNumber, sizeBytes, sha256] of [
    [1, partBytes, '080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e'],
    [2, 3, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ]) {
    const op = `resume-${partNumber}`;
    await sql('INSERT INTO drive_upload_part_operations VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?)',
      op, id, principalId, key, epoch, uploadId, partNumber, sizeBytes);
    await sql('INSERT INTO drive_upload_part_byte_evidence VALUES (?, ?, ?)',
      op, Uint8Array.from(Buffer.from(sha256, 'hex')).buffer, Uint8Array.from([34, 97, 34]).buffer);
    parts.push({ partNumber, sizeBytes, sha256 });
  }
  for (const [intent, expected] of [[id, parts], [empty, []]]) {
    const response = await ask(uploadResumePath(intent), owner, { 'sec-fetch-site': 'same-origin' });
    assert.deepEqual([response.status, response.headers.get('cache-control'), response.headers.get('content-type'), await response.json()],
      [200, 'private, no-store', 'application/json', { declaredSize, parts: expected }]);
  }
  const wrongMethod = await ask(undefined, owner, { origin }, 'POST');
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  await denied(wrongMethod, 405);
  await denied(await ask(undefined, owner, { 'sec-fetch-site': 'same-site' }), 403);
  await denied(await ask(undefined, owner, { origin: 'https://other.example.test' }), 403);
  await denied(await ask(`${uploadResumePath(id)}?principalId=${principalId}`), 400);
  for (const path of [uploadResumePath(id.toUpperCase()), `${uploadResumePath(id)}/extra`]) {
    assert.equal((await ask(path)).status, 404);
  }
  await denied(await ask(undefined, owner, { 'x-test-resume-no-storage': '1' }), 503);
  await denied(await ask(undefined, other), 404);
  await denied(await ask(uploadResumePath(randomUUID())), 404);
  await denied(await ask(uploadResumePath(wrongBinding)), 404);
  await denied(await ask(uploadResumePath(unallocated)), 404);
  await sql("INSERT INTO drive_upload_part_observations VALUES ('resume-2', 'uncertain', NULL)");
  await denied(await ask(), 404);
  // Both intents remain allocated; the original bearer must not recover after reactivation.
  await sql("UPDATE drive_sessions SET expires_at = 0 WHERE principal_id = 'stale-resume-member'");
  await denied(await ask(uploadResumePath(staleIntent), stale), 401);
  await sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", principalId);
  await denied(await ask(uploadResumePath(empty)), 401);
  await sql("UPDATE drive_principals SET status = 'active' WHERE id = ?", principalId);
  await denied(await ask(uploadResumePath(empty)), 401);
  console.log('Disposable Worker: upload resume evidence HTTP checks passed');
}
