import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadOperationEvidence } from '../../drive/src/lib/server/metadata/upload-operation-evidence.ts';

const migration = '0019_upload_operation_evidence.sql';
const migrate = (limit = migration) => applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name <= limit));
const run = (sql) => env.DB.prepare(sql).run();
const rows = async (sql) => (await env.DB.prepare(sql).all()).results;
const operation = (id) => ({ operationId: id, intentId: `intent-${id}`, ownerId: 'alice', objectKey: `key-${id}`,
  storageEpoch: 'epoch-1', uploadId: 'opaque-upload-id', intentVersion: 3 });
const bytes = new Uint8Array([99, 0, 255, 128, 99]).subarray(1, 4);
const operations = 'drive_upload_completion_operations';
const evidence = 'drive_upload_completion_evidence';
const journal = 'SELECT * FROM drive_upload_intents';
const insertIntent = (op, state, ack = 0) => env.DB.prepare(`INSERT INTO drive_upload_intents
  (id, owner_id, object_key, upload_id, state, version, completion_acknowledged) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .bind(op.intentId, op.ownerId, op.objectKey, op.uploadId, state, op.intentVersion, ack).run();

it('upgrades through 0019 without treating a legacy journal acknowledgement as evidence', async () => {
  const op = operation('legacy');
  await migrate('0018_upload_intent_identity_reservations.sql');
  await insertIntent(op, 'acknowledged', 1);
  const before = await rows(journal);
  await migrate();
  await migrate();
  expect(await rows(journal)).toEqual(before);
  expect(await rows(`SELECT * FROM ${operations}`)).toEqual([]);
  expect(await rows(`SELECT * FROM ${evidence}`)).toEqual([]);
  const ledger = new UploadOperationEvidence(env.DB);
  await expect(ledger.reconcileReceiptWrite(op, bytes)).resolves.toBe('unknown');
  await expect(ledger.storeUnverifiedReceipt(op, bytes)).rejects.toThrow('No matching upload completion operation');
});

it('enforces exact identity and immutable, non-replaceable evidence', async () => {
  const op = operation('op');
  await migrate();
  await insertIntent(op, 'completing');
  const ledger = new UploadOperationEvidence(env.DB);
  const wrong = { intentId: 'missing', ownerId: 'bob', objectKey: 'other-key',
    operationId: 'other-op', storageEpoch: 'epoch-2', uploadId: 'other-upload', intentVersion: 4 };
  for (const field of ['intentId', 'ownerId', 'objectKey'])
    await expect(ledger.recordOperation({ ...op, [field]: wrong[field] })).rejects.toThrow('invalid or duplicate');
  await expect(run(`INSERT INTO ${operations} VALUES ('op', 'intent-op', 'alice', 'key-op', x'01', 'upload', 3)`))
    .rejects.toThrow('cannot store BLOB');
  await ledger.recordOperation(op);
  await ledger.storeUnverifiedReceipt(op, bytes);
  for (const [field, value] of Object.entries(wrong)) {
    const mismatch = { ...op, [field]: value };
    await expect(ledger.storeUnverifiedReceipt(mismatch, bytes)).rejects.toThrow('No matching upload completion operation');
    await expect(ledger.reconcileReceiptWrite(mismatch, bytes)).resolves.toBe('unknown');
  }
  const before = await rows(`SELECT * FROM ${operations}`);
  for (const policy of ['', 'OR ABORT', 'OR IGNORE', 'OR REPLACE', 'OR FAIL', 'OR ROLLBACK']) {
    for (const [id, version] of [["'alias'", 'intent_version'], ['operation_id', 'intent_version + 1']])
      await expect(run(`INSERT ${policy} INTO ${operations} SELECT ${id}, intent_id, owner_id, object_key,
        storage_epoch, upload_id, ${version} FROM ${operations}`)).rejects.toThrow('invalid or duplicate');
    for (const id of ['op', 'missing'])
      await expect(run(`INSERT ${policy} INTO ${evidence} VALUES ('${id}', x'01')`)).rejects.toThrow('invalid or duplicate');
    await expect(run(`UPDATE ${policy} ${operations} SET intent_version = 4`)).rejects.toThrow('immutable');
    await expect(run(`UPDATE ${policy} ${evidence} SET receipt_bytes = x'01'`)).rejects.toThrow('immutable');
  }
  await expect(run(`INSERT INTO ${evidence} VALUES ('op', x'01') ON CONFLICT DO NOTHING`)).rejects.toThrow('invalid or duplicate');
  for (const table of [evidence, operations]) await expect(run(`DELETE FROM ${table}`)).rejects.toThrow('permanent');
  expect(await rows(`SELECT * FROM ${operations}`)).toEqual(before);
  expect(await rows(`SELECT hex(receipt_bytes) AS receipt FROM ${evidence}`)).toEqual([{ receipt: '00FF80' }]);
});

it('reconciles a late committed receipt after D1 acknowledgement loss without changing authority', async () => {
  const op = operation('late');
  await migrate();
  await run("INSERT INTO drive_principals (id, role, status) VALUES ('alice', 'member', 'active')");
  await insertIntent(op, 'completing');
  const ledger = new UploadOperationEvidence(env.DB);
  await ledger.recordOperation(op);
  await run("UPDATE drive_principals SET status = 'revoked' WHERE id = 'alice'");
  await run("UPDATE drive_upload_intents SET state = 'uncertain', version = version + 1 WHERE id = 'intent-late'");
  const before = await rows(journal);
  await expect(ledger.reconcileReceiptWrite(op, bytes)).resolves.toBe('unknown');
  const lostAck = new UploadOperationEvidence({ prepare: (sql) => ({ bind: (...args) => ({ async first() {
    expect(await env.DB.prepare(sql).bind(...args).first()).toEqual({ operation_id: op.operationId });
    throw new Error('D1 acknowledgement lost');
  } }) }) });
  await expect(lostAck.storeUnverifiedReceipt(op, bytes)).rejects.toThrow('D1 acknowledgement lost');
  expect(await rows(journal)).toEqual(before);
  await run("DELETE FROM drive_upload_intents WHERE id = 'intent-late'");
  const reconciler = new UploadOperationEvidence({ withSession(constraint) {
    expect(constraint).toBe('first-primary');
    return env.DB.withSession(constraint);
  } });
  await expect(reconciler.reconcileReceiptWrite(op, bytes)).resolves.toBe('recorded');
  await expect(reconciler.reconcileReceiptWrite(op, new Uint8Array([0, 255, 129]))).resolves.toBe('conflict');
  const unavailable = new UploadOperationEvidence({ withSession() { throw new Error('primary unavailable'); } });
  await expect(unavailable.reconcileReceiptWrite(op, bytes)).rejects.toThrow('primary unavailable');
  const oversized = new Uint8Array(65537);
  Object.defineProperty(oversized, 'byteLength', { value: 1 });
  await expect(reconciler.reconcileReceiptWrite(op, oversized)).rejects.toThrow('Invalid completion evidence size');
  await expect(insertIntent(op, 'completing')).rejects.toThrow('upload intent ID already reserved');
  expect(await rows(`${journal} WHERE id = 'intent-late'`)).toEqual([]);
  for (const table of ['drive_active_members', 'drive_entries', 'drive_read_grants'])
    expect(await rows(`SELECT * FROM ${table}`)).toEqual([]);
});
