import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { captureUploadPartAcknowledgement, UploadPartByteEvidence } from '../../drive/src/lib/server/metadata/upload-part-byte-evidence.ts';
import { UploadPartOperationEvidence } from '../../drive/src/lib/server/metadata/upload-part-operation-evidence.ts';
import { createMultipartUpload } from '../../drive/src/lib/server/s3/multipart-upload.ts';
import { config, epoch, migrations, sql } from './fixtures/upload-completion.mjs';

const { endpoint, bucket } = config;
const bytes = () => Uint8Array.of(97, 98, 99); // SHA-256('abc')
const etag = '"opaque-ÿ"';
const etagBytes = Uint8Array.from(etag, (char) => char.charCodeAt(0));
const evidence = () => new UploadPartByteEvidence(env.DB);
const ledger = () => new UploadPartOperationEvidence(env.DB);
const receipt = (scope) => sql(`SELECT r.kind, hex(r.reported_etag) AS tag, hex(e.sha256) AS digest
  FROM drive_upload_part_observations r LEFT JOIN drive_upload_part_byte_evidence e USING (operation_id)
  WHERE r.operation_id = ? AND r.kind = 'reported'`, scope.operationId).first();
const sha256 = 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD';

async function setup(schema = migrations, bound = true) {
  const id = crypto.randomUUID();
  const scope = { operationId: `part-${id}`, intentId: `intent-${id}`, ownerId: `owner-${id}`, objectKey: `key-${id}`,
    storageEpoch: epoch, uploadId: `upload-${id}`, intentVersion: 2, partNumber: 2, sizeBytes: 3, endpoint, bucket };
  await applyD1Migrations(env.DB, schema);
  await sql("INSERT INTO drive_principals (id, role, status) VALUES (?, 'member', 'active')", scope.ownerId).run();
  await sql("INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size) VALUES (?, ?, ?, 'created', ?)",
    scope.intentId, scope.ownerId, scope.objectKey, scope.sizeBytes).run();
  if (bound) await sql('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)', scope.intentId, endpoint, bucket, epoch).run();
  await sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = ? WHERE id = ?",
    scope.uploadId, scope.intentVersion, scope.intentId).run();
  await ledger().recordAdmission(scope);
  return scope;
}

const send = async (target, body) => ({ partNumber: target.partNumber, etag, size: body.byteLength });
const capture = (part, body = bytes()) => captureUploadPartAcknowledgement(part, body, send);

// D1 state is shared by tests in this file. Exercise the upgrade before tests
// that start on the latest schema.
it('does not retrofit old receipts during or after the migration', async () => {
  const name = '0035_upload_part_byte_evidence.sql';
  const scope = await setup(migrations.filter((m) => m.name < name));
  expect(await sql("SELECT name FROM sqlite_master WHERE name = 'drive_upload_part_byte_evidence'").first()).toBeNull();
  await ledger().recordObservation(scope, etagBytes);
  await applyD1Migrations(env.DB, migrations);
  expect(await evidence().matches(scope, bytes())).toBe(false);
  await expect(evidence().recordAcknowledged(await capture(scope))).rejects.toThrow('invalid or duplicate');
  expect(await receipt(scope)).toEqual({ kind: 'reported', tag: '226F70617175652DFF22', digest: '' });
});

it('atomically records the opaque receipt and SHA-256 of the exact bounded bytes sent', async () => {
  const scope = await setup();
  const provider = vi.fn(async (request) => {
    expect(request.method).toBe('PUT');
    expect(new URL(request.url).searchParams.get('partNumber')).toBe(String(scope.partNumber));
    expect(request.headers.get('x-amz-content-sha256')).toBe(sha256.toLowerCase());
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes());
    return new Response(null, { headers: { etag } });
  });
  const upload = createMultipartUpload(config, { fetch: provider, timeoutMs: 5000 });
  const backing = Uint8Array.of(0, ...bytes(), 0);
  const requestBytes = backing.subarray(1, 4), targetScope = { ...scope };
  expect(await evidence().readAcknowledged(scope)).toBeNull(); // Claim only.
  const pending = captureUploadPartAcknowledgement(targetScope, requestBytes, (target, snapshot) => {
    expect(target).toEqual({ endpoint, bucket, storageEpoch: epoch, objectKey: scope.objectKey,
      uploadId: scope.uploadId, partNumber: scope.partNumber });
    return upload(target.objectKey, target.uploadId, target.partNumber, snapshot);
  });
  requestBytes.fill(0);
  targetScope.objectKey = 'replacement-key';
  const proof = await pending;
  expect(await receipt(scope)).toBeNull(); // An acknowledgement in memory is not durable evidence.
  await evidence().recordAcknowledged(proof);
  expect(await receipt(scope)).toEqual({ kind: 'reported', tag: '226F70617175652DFF22', digest: sha256 });
  expect(await evidence().readAcknowledged(scope)).toEqual({ sha256: sha256.toLowerCase() });
  expect(await evidence().matches(scope, bytes())).toBe(true);
  expect(await evidence().matches(scope, requestBytes)).toBe(false);
  expect(provider).toHaveBeenCalledTimes(1);
});

it('does not substitute scope fields, digests, or bare acknowledgements', async () => {
  const scope = await setup();
  const changes = { operationId: 'other-op', intentId: 'intent-2', ownerId: 'owner-2', objectKey: 'other-key',
    storageEpoch: 'epoch-2', uploadId: 'upload-2', intentVersion: 3, partNumber: 3, sizeBytes: 4,
    endpoint: 'https://other.example', bucket: 'other-bucket' };
  await expect(evidence().recordAcknowledged({})).rejects.toThrow('Invalid upload part proof');
  for (const [key, value] of Object.entries(changes)) {
    const other = { ...scope, [key]: value };
    await expect(evidence().recordAcknowledged(await capture(other, new Uint8Array(other.sizeBytes))))
      .rejects.toThrow('No matching live upload part operation');
  }
  expect(await receipt(scope)).toBeNull();
  await evidence().recordAcknowledged(await capture(scope));
  for (const [key, value] of Object.entries(changes)) {
    const other = { ...scope, [key]: value };
    expect(await evidence().matches(other, new Uint8Array(other.sizeBytes).fill(97).map((n, i) => n + i))).toBe(false);
  }
});

it.each(['missing binding', 'version advanced', 'revoked owner', 'uncertain observation'])('rejects evidence for %s', async (state) => {
  const scope = await setup(migrations, state !== 'missing binding');
  const proof = await capture(scope);
  if (state === 'version advanced') await sql('UPDATE drive_upload_intents SET version = version + 1 WHERE id = ?', scope.intentId).run();
  if (state === 'revoked owner') await sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", scope.ownerId).run();
  if (state === 'uncertain observation') await ledger().recordObservation(scope, null);
  await expect(evidence().recordAcknowledged(proof)).rejects.toThrow('No matching live upload part operation');
  expect(await evidence().matches(scope, bytes())).toBe(false);
  expect(await receipt(scope)).toBeNull();
});

it('does not mint proof for a failed or mismatched provider acknowledgement', async () => {
  const scope = await setup();
  const lost = vi.fn(async () => { throw new Error('provider response lost'); });
  await expect(captureUploadPartAcknowledgement(scope, bytes(), lost)).rejects.toThrow('provider response lost');
  expect(lost).toHaveBeenCalledTimes(1);
  for (const patch of [{ partNumber: 3 }, { size: 4 }, { etag: 'not an ETag' }]) {
    await expect(captureUploadPartAcknowledgement(scope, bytes(), async (target, body) => ({ ...await send(target, body), ...patch })))
      .rejects.toThrow('Invalid upload part acknowledgement');
  }
  await expect(captureUploadPartAcknowledgement(scope, Uint8Array.of(1), lost)).rejects.toThrow('Invalid upload part bytes');
  expect(lost).toHaveBeenCalledTimes(1);
  expect(await evidence().matches(scope, bytes())).toBe(false);
  expect(await receipt(scope)).toBeNull();
});

it('preserves the first evidence across duplicates and never erases later uncertainty', async () => {
  const scope = await setup();
  const proof = await capture(scope);
  await evidence().recordAcknowledged(proof);
  const original = await receipt(scope);
  await expect(evidence().recordAcknowledged(proof)).rejects.toThrow('invalid or duplicate');
  await expect(evidence().recordAcknowledged(await capture(scope, Uint8Array.of(0, 0, 0)))).rejects.toThrow('invalid or duplicate');
  for (const statement of ['UPDATE drive_upload_part_byte_evidence SET sha256 = zeroblob(32)',
    'DELETE FROM drive_upload_part_byte_evidence', 'INSERT OR REPLACE INTO drive_upload_part_byte_evidence SELECT * FROM drive_upload_part_byte_evidence']) {
    await expect(sql(`${statement} WHERE operation_id = ?`, scope.operationId).run()).rejects.toThrow();
  }
  expect(await receipt(scope)).toEqual(original);
  await ledger().recordObservation(scope, null);
  expect(await evidence().matches(scope, bytes())).toBe(false);
});

it('keeps the existing seal contract and makes sealed evidence ineligible for reuse', async () => {
  const scope = await setup();
  await evidence().recordAcknowledged(await capture(scope));
  await sql('INSERT INTO drive_upload_completion_operations VALUES (?, ?, ?, ?, ?, ?, ?)', 'seal',
    scope.intentId, scope.ownerId, scope.objectKey, epoch, scope.uploadId, scope.intentVersion).run();
  await sql('INSERT INTO drive_upload_sealed_snapshots VALUES (?, ?, ?)', 'seal', '[2]', scope.sizeBytes).run();
  expect(await receipt(scope)).toMatchObject({ digest: sha256 });
  expect(await evidence().matches(scope, bytes())).toBe(false);
});

it.each([true, false])('only the primary can resolve a lost D1 acknowledgement (committed: %s)', async (committed) => {
  const scope = await setup();
  const db = {
    prepare: (query) => ({ bind: (...args) => ({ async first() {
      if (committed) await sql(query, ...args).first();
      throw new Error('D1 acknowledgement lost');
    } }) }),
    withSession: vi.fn((mode) => env.DB.withSession(mode))
  };
  const store = new UploadPartByteEvidence(db);
  await expect(store.recordAcknowledged(await capture(scope))).rejects.toThrow('D1 acknowledgement lost');
  expect(await store.matches(scope, bytes())).toBe(committed);
  expect(db.withSession).toHaveBeenCalledExactlyOnceWith('first-primary');
});
