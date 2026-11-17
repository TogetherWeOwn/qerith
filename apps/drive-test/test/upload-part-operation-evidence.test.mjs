import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { UploadPartOperationEvidence } from '../../drive/src/lib/server/metadata/upload-part-operation-evidence.ts';

const prior = '0019_upload_operation_evidence.sql';
const migration = '0020_upload_part_operation_evidence.sql';
const migrate = (limit = migration) => applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name <= limit));
const run = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const rows = async (sql) => (await env.DB.prepare(sql).all()).results;
const operations = 'drive_upload_part_operations';
const observations = 'drive_upload_part_observations';
const etag = '"unverified-tag"';
const operation = (id) => ({ operationId: id, intentId: `intent-${id}`, ownerId: `owner-${id}`,
  objectKey: `key-${id}`, storageEpoch: 'epoch-1', uploadId: 'opaque-upload-id', intentVersion: 2,
  partNumber: 1, sizeBytes: 5 });
const insertIntent = (op, state = 'allocated', acknowledged = 0) => run(`INSERT INTO drive_upload_intents
  (id, owner_id, object_key, upload_id, version, state, completion_acknowledged) VALUES (?, ?, ?, ?, ?, ?, ?)`,
op.intentId, op.ownerId, op.objectKey, op.uploadId, op.intentVersion, state, acknowledged);
async function seed(op) {
  await run("INSERT INTO drive_principals VALUES (?, 'member', 'active')", op.ownerId);
  await insertIntent(op);
}
const ledger = () => new UploadPartOperationEvidence(env.DB);

it('upgrades 0019 without inferring part evidence from legacy rows', async () => {
  const op = operation('legacy-part');
  await migrate(prior);
  await insertIntent(op, 'acknowledged', 1);
  const before = await rows('SELECT * FROM drive_upload_intents');
  await migrate();
  await migrate();
  expect(await rows('SELECT * FROM drive_upload_intents')).toEqual(before);
  expect(await rows(`SELECT * FROM ${operations}`)).toEqual([]);
  expect(await rows(`SELECT * FROM ${observations}`)).toEqual([]);
  await expect(ledger().reconcileAdmissionWrite(op)).resolves.toBe('unknown');
  await expect(ledger().reconcileObservationWrite(op, etag)).resolves.toBe('unknown');
});

it('records evidence only for a live exact allocation and does not fence existing writers', async () => {
  const op = operation('admission');
  await migrate();
  await seed(op);
  for (const [key, value] of Object.entries({ intentId: 'missing', ownerId: 'other',
    objectKey: 'wrong-key', uploadId: 'other-upload', intentVersion: 1 })) {
    await expect(ledger().recordAdmission({ ...op, [key]: value })).rejects.toThrow('invalid or duplicate');
  }
  const competing = { ...op, operationId: 'competing-part' };
  const attempts = [op, competing];
  const results = await Promise.allSettled(attempts.map((attempt) => ledger().recordAdmission(attempt)));
  expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
  const admitted = attempts[results.findIndex(({ status }) => status === 'fulfilled')];
  await expect(ledger().reconcileAdmissionWrite(admitted)).resolves.toBe('recorded');
  const anotherPart = { ...op, operationId: 'another-part', partNumber: 2 };
  await ledger().recordAdmission(anotherPart);
  const intents = new UploadIntents(env.DB);
  const completion = await intents.claim(op.ownerId, op.intentId, op.intentVersion, 'completion');
  expect(completion).toMatchObject({ state: 'completing', version: 3 });
  await expect(ledger().recordAdmission({ ...anotherPart, operationId: 'stale', partNumber: 3 }))
    .rejects.toThrow('invalid or duplicate');
  await expect(ledger().recordAdmission({ ...anotherPart, operationId: 'sealed', partNumber: 3, intentVersion: 3 }))
    .rejects.toThrow('invalid or duplicate');
  await run('UPDATE drive_upload_intents SET state = ?, version = 4 WHERE id = ?', 'allocated', op.intentId);
  await expect(ledger().recordAdmission({ ...op, operationId: 'attempt-on-new-version', intentVersion: 4 }))
    .rejects.toThrow('invalid or duplicate');
  await run("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", op.ownerId);
  await expect(ledger().recordAdmission({ ...anotherPart, operationId: 'revoked', partNumber: 3, intentVersion: 4 }))
    .rejects.toThrow('invalid or duplicate');
});

it('cannot replace an operation or observation through SQLite conflict policies', async () => {
  const op = operation('immutable-part');
  await migrate();
  await seed(op);
  await ledger().recordAdmission(op);
  await ledger().recordObservation(op, etag);
  for (const policy of ['', 'OR ABORT', 'OR IGNORE', 'OR REPLACE', 'OR FAIL', 'OR ROLLBACK']) {
    for (const [id, part] of [["'alias'", 'part_number'], ['operation_id', 'part_number + 1']]) {
      await expect(run(`INSERT ${policy} INTO ${operations} SELECT ${id}, intent_id, owner_id, object_key,
        storage_epoch, upload_id, intent_version, ${part}, size_bytes FROM ${operations} WHERE operation_id = ?`, op.operationId))
        .rejects.toThrow('invalid or duplicate');
    }
    for (const id of [op.operationId, 'absent']) {
      await expect(run(`INSERT ${policy} INTO ${observations} VALUES (?, 'reported', 'different')`, id))
        .rejects.toThrow('invalid or duplicate');
    }
    await expect(run(`UPDATE ${policy} ${operations} SET size_bytes = 0 WHERE operation_id = ?`, op.operationId))
      .rejects.toThrow('immutable');
    await expect(run(`UPDATE ${policy} ${observations} SET reported_etag = 'changed' WHERE operation_id = ?`, op.operationId))
      .rejects.toThrow('immutable');
  }
  await expect(run(`INSERT INTO ${observations} VALUES (?, 'reported', 'different')
    ON CONFLICT (operation_id, kind) DO UPDATE SET reported_etag = excluded.reported_etag`, op.operationId))
    .rejects.toThrow('invalid or duplicate');
  for (const table of [observations, operations]) {
    await expect(run(`DELETE FROM ${table} WHERE operation_id = ?`, op.operationId)).rejects.toThrow('permanent');
  }
  await expect(ledger().reconcileObservationWrite(op, etag)).resolves.toBe('recorded');
  await expect(ledger().recordObservation(op, 'é'.repeat(513))).rejects.toThrow('Invalid reported part ETag');
  await expect(ledger().reconcileObservationWrite(op, '\ud800')).rejects.toThrow('Invalid reported part ETag');
});

it('resolves lost D1 acknowledgements and records a late report without clearing uncertainty', async () => {
  const op = operation('late-part');
  await migrate();
  await seed(op);
  const lostAck = new UploadPartOperationEvidence({ prepare: (sql) => ({ bind: (...args) => ({ async first() {
    expect(await env.DB.prepare(sql).bind(...args).first()).toEqual({ operation_id: op.operationId });
    throw new Error('D1 acknowledgement lost');
  } }) }) });
  const reconciler = new UploadPartOperationEvidence({ withSession(constraint) {
    expect(constraint).toBe('first-primary');
    return env.DB.withSession(constraint);
  } });
  await expect(lostAck.recordAdmission(op)).rejects.toThrow('D1 acknowledgement lost');
  await expect(reconciler.reconcileAdmissionWrite(op)).resolves.toBe('recorded');
  await ledger().recordObservation(op, null);
  await expect(reconciler.reconcileObservationWrite(op, etag)).resolves.toBe('unknown');
  await expect(ledger().recordAdmission({ ...op, operationId: 'after-uncertainty' })).rejects.toThrow('invalid or duplicate');
  await run("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", op.ownerId);
  await run('DELETE FROM drive_upload_intents WHERE id = ?', op.intentId);
  await expect(lostAck.recordObservation(op, etag)).rejects.toThrow('D1 acknowledgement lost');
  const mismatches = { operationId: 'another-operation', intentId: 'another-intent', ownerId: 'another-owner',
    objectKey: 'another-key', storageEpoch: 'another-epoch', uploadId: 'another-upload', intentVersion: 3,
    partNumber: 2, sizeBytes: 6 };
  for (const [key, value] of Object.entries(mismatches)) {
    const wrong = { ...op, [key]: value };
    await expect(ledger().recordObservation(wrong, etag)).rejects.toThrow('No matching upload part operation');
    await expect(reconciler.reconcileAdmissionWrite(wrong)).resolves.toBe('unknown');
    await expect(reconciler.reconcileObservationWrite(wrong, etag)).resolves.toBe('unknown');
  }
  await expect(reconciler.reconcileObservationWrite(op, etag)).resolves.toBe('recorded');
  await expect(reconciler.reconcileObservationWrite(op, '"different"')).resolves.toBe('conflict');
  await expect(reconciler.reconcileObservationWrite(op, null)).resolves.toBe('recorded');
  await expect(insertIntent({ ...op, objectKey: 'alternate-key' })).rejects.toThrow('upload intent ID already reserved');
  expect(await rows("SELECT id FROM drive_upload_intents WHERE id = 'intent-late-part'")).toEqual([]);
  expect(await rows("SELECT id FROM drive_active_members WHERE id = 'owner-late-part'")).toEqual([]);
  for (const table of ['drive_entries', 'drive_read_grants', 'drive_upload_completion_evidence']) {
    expect(await rows(`SELECT * FROM ${table}`)).toEqual([]);
  }
});
