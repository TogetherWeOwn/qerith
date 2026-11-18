import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { Sessions } from '../../drive/src/lib/server/identity/sessions.ts';
import { createUploadCompletionReceipts } from '../../drive/src/lib/server/metadata/upload-completion-receipts.ts';
import { UploadOperationEvidence } from '../../drive/src/lib/server/metadata/upload-operation-evidence.ts';
import { UploadPartOperationEvidence } from '../../drive/src/lib/server/metadata/upload-part-operation-evidence.ts';
import { UploadSealedEvidence } from '../../drive/src/lib/server/metadata/upload-sealed-evidence.ts';

const migration = '0022_upload_publication_receipts.sql';
const migrate = (limit = migration) => applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name <= limit));
const statement = (sql, ...args) => env.DB.prepare(sql).bind(...args);
const sessions = new Sessions(env.DB);
const operations = new UploadOperationEvidence(env.DB);
const ledger = new UploadPartOperationEvidence(env.DB);
const sealed = new UploadSealedEvidence(env.DB);
const config = { endpoint: 'https://storage.example', bucket: 'drive-test', region: 'auto', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
const parts = [{ partNumber: 2, etag: '"part-&-ÿ"', size: 7 }];
const response = (key = 'reserved-key') => new Response(`<CompleteMultipartUploadResult><Bucket>drive-test</Bucket><Key>${key}</Key><ETag>"final-opaque"</ETag><ChecksumSHA256>example-checksum</ChecksumSHA256><ChecksumType>COMPOSITE</ChecksumType></CompleteMultipartUploadResult>`);
const receipt = () => statement('SELECT * FROM drive_upload_completion_receipts').first();

async function seed() {
  const op = { operationId: 'complete-one', intentId: 'intent-one', ownerId: 'owner-one', objectKey: 'reserved-key',
    uploadId: 'upload/+id', storageEpoch: 'epoch-1', intentVersion: 2 };
  await statement("INSERT INTO drive_principals VALUES (?, 'member', 'active')", op.ownerId).run();
  await statement("INSERT INTO drive_upload_intents VALUES (?, ?, ?, ?, 0, 'allocated', 2)", op.intentId, op.ownerId, op.objectKey, op.uploadId).run();
  await operations.recordOperation(op);
  const part = { ...op, operationId: 'part-one', partNumber: 2, sizeBytes: 7 };
  await ledger.recordAdmission(part);
  await ledger.recordObservation(part, Uint8Array.from(parts[0].etag, (char) => char.charCodeAt(0)));
  await sealed.recordSnapshot({ operation: op, partNumbers: [2], sizeBytes: 7 });
  return { op, part, token: (await sessions.issue(op.ownerId)).token };
}

function producer(fetch, verified = parts, db = env.DB) {
  const verifier = { isQualified: vi.fn(async (id) => id === '["https://storage.example","drive-test","epoch-1"]'),
    verifyParts: vi.fn(async () => verified) };
  return { ...createUploadCompletionReceipts(db, 'epoch-1', config, { fetch, timeoutMs: 5000 }, verifier), verifier };
}

it('upgrades sealed observations without backfilling trusted dispatches or receipts', async () => {
  await migrate('0021_upload_sealed_evidence.sql');
  const { op, token } = await seed();
  await operations.storeUnverifiedReceipt(op, new Uint8Array([1, 2]));
  await statement("UPDATE drive_upload_intents SET state = 'acknowledged', completion_acknowledged = 1").run();
  await migrate();
  await migrate();
  const fetch = vi.fn();
  await expect(producer(fetch).complete(token, op.operationId)).resolves.toBe('not-admitted');
  expect(await receipt()).toBeNull();
  expect(await statement('SELECT * FROM drive_upload_completion_dispatches').first()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('admits a single signed create-only completion and reconciles a lost receipt acknowledgement', async () => {
  await migrate();
  const { op, token } = await seed();
  const fetch = vi.fn(async (request) => {
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://storage.example/drive-test/reserved-key?uploadId=upload%2F%2Bid');
    expect(request.headers.get('if-none-match')).toBe('*');
    expect(request.headers.get('authorization')).toMatch(/SignedHeaders=[^,]*if-none-match/);
    expect(await request.text()).toContain('<PartNumber>2</PartNumber><ETag>"part-&amp;-ÿ"</ETag>');
    return response();
  });
  const db = { withSession: vi.fn((mode) => env.DB.withSession(mode)), prepare: (sql) => sql.includes('INSERT INTO drive_upload_completion_receipts')
    ? { bind: (...args) => ({ async first() { await statement(sql, ...args).first(); throw new Error('lost acknowledgement'); } }) }
    : env.DB.prepare(sql) };
  const first = producer(fetch, parts, db);
  const results = await Promise.all([first.complete(token, op.operationId), first.complete(token, op.operationId)]);
  expect(results.sort()).toEqual(['not-admitted', 'recorded']);
  expect(db.withSession).toHaveBeenCalledTimes(3);
  expect(fetch).toHaveBeenCalledTimes(1);
  const durable = await receipt();
  expect(durable).toMatchObject({ operation_id: op.operationId, etag: '"final-opaque"' });
  expect(JSON.parse(durable.response_checksums)).toEqual({ ChecksumSHA256: 'example-checksum', ChecksumType: 'COMPOSITE' });
  await expect(producer(fetch).complete(token, op.operationId)).resolves.toBe('not-admitted');
  expect(await receipt()).toEqual(durable);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('fails closed for unqualified, foreign, revoked, and mismatched part evidence', async () => {
  await migrate();
  const { op, part, token } = await seed();
  await statement("INSERT INTO drive_principals VALUES ('other', 'member', 'active')").run();
  const fetch = vi.fn();
  const unqualified = createUploadCompletionReceipts(env.DB, 'epoch-1', config, { fetch, timeoutMs: 5000 });
  await expect(unqualified.complete(token, op.operationId)).resolves.toBe('not-admitted');
  await expect(producer(fetch).complete((await sessions.issue('other')).token, op.operationId)).resolves.toBe('not-admitted');
  await expect(producer(fetch, [{ ...parts[0], etag: '"different"' }]).complete(token, op.operationId)).resolves.toBe('not-admitted');
  const pending = producer(fetch);
  pending.verifier.verifyParts.mockImplementation(async () => { await ledger.recordObservation(part, null); return parts; });
  await expect(pending.complete(token, op.operationId)).resolves.toBe('not-admitted');
  await sessions.revoke(token);
  await expect(producer(fetch).complete(token, op.operationId)).resolves.toBe('not-admitted');
  expect(await receipt()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['malformed', 'mismatched', 'lost'])('quarantines a %s provider response without dispatching again', async (failure) => {
  await migrate();
  const { op, token } = await seed();
  const fetch = vi.fn(async () => {
    if (failure === 'lost') throw new Error('lost provider acknowledgement');
    return failure === 'mismatched' ? response('another-key') : new Response('<CompleteMultipartUploadResult />');
  });
  await expect(producer(fetch).complete(token, op.operationId)).resolves.toBe('uncertain');
  await expect(producer(fetch).complete(token, op.operationId)).resolves.toBe('not-admitted');
  expect(await statement('SELECT operation_id FROM drive_upload_completion_quarantine').first()).toEqual({ operation_id: op.operationId });
  expect(await receipt()).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
