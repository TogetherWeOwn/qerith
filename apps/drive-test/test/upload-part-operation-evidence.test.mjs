import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { UploadPartOperationEvidence } from '../../drive/src/lib/server/metadata/upload-part-operation-evidence.ts';

const migration = '0020_upload_part_operation_evidence.sql';
const migrate = () => applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name <= migration));
const run = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const rows = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const operations = 'drive_upload_part_operations';
const observations = 'drive_upload_part_observations';
const etag = new Uint8Array([99, 0x22, 0x80, 0xff, 0x22, 99]).subarray(1, 5);
const operation = (id) => ({ operationId: id, intentId: `intent-${id}`, ownerId: `owner-${id}`,
  objectKey: `key-${id}`, storageEpoch: 'epoch-1', uploadId: 'opaque-upload-id', intentVersion: 2,
  partNumber: 1, sizeBytes: 5 });
const insertIntent = (op) => run(`INSERT INTO drive_upload_intents
  (id, owner_id, object_key, upload_id, version, state) VALUES (?, ?, ?, ?, ?, 'allocated')`,
  op.intentId, op.ownerId, op.objectKey, op.uploadId, op.intentVersion);
async function seed(op) {
  await run("INSERT INTO drive_principals VALUES (?, 'member', 'active')", op.ownerId);
  await insertIntent(op);
}
const ledger = () => new UploadPartOperationEvidence(env.DB);

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
  await expect(intents.recordNotDispatched(op.ownerId, op.intentId, 3, 'completion')).resolves.toBe(true);
  await expect(ledger().recordAdmission({ ...op, operationId: 'attempt-on-new-version', intentVersion: 4 }))
    .rejects.toThrow('invalid or duplicate');
  await ledger().recordAdmission({ ...op, operationId: 'unused-on-new-version', partNumber: 3, intentVersion: 4 });
  await run("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", op.ownerId);
  await expect(ledger().recordAdmission({ ...op, operationId: 'revoked', partNumber: 4, intentVersion: 4 }))
    .rejects.toThrow('invalid or duplicate');
});

it('matches inherited SQLite text by its exact bytes without changing legacy writers', async () => {
  const op = { ...operation('legacy-bytes'), intentId: new Uint8Array([0x61, 0, 0x80]),
    ownerId: new Uint8Array([0x62, 0x81]), objectKey: new Uint8Array([0x63, 0x82]),
    uploadId: new Uint8Array([0x64, 0x83]) };
  await migrate();
  await run("INSERT INTO drive_principals VALUES (CAST(x'6281' AS TEXT), 'member', 'active')");
  await run(`INSERT INTO drive_upload_intents (id, owner_id, object_key, upload_id, version, state)
    VALUES (CAST(x'610080' AS TEXT), CAST(x'6281' AS TEXT), CAST(x'6382' AS TEXT), CAST(x'6483' AS TEXT), 2, 'allocated')`);
  await run(`INSERT INTO ${operations} SELECT ?, id, owner_id, object_key, ?, upload_id, version, 1, 5
    FROM drive_upload_intents WHERE id = CAST(x'610080' AS TEXT)`, op.operationId, op.storageEpoch);
  await expect(ledger().reconcileAdmissionWrite(op)).resolves.toBe('recorded');
  await ledger().recordObservation(op, etag);
  await expect(ledger().reconcileObservationWrite(op, etag)).resolves.toBe('recorded');
  for (const key of ['intentId', 'ownerId', 'objectKey', 'uploadId']) {
    const lossy = { ...op, [key]: new TextDecoder().decode(op[key]) };
    await expect(ledger().recordObservation(lossy, null)).rejects.toThrow('No matching upload part operation');
    await expect(ledger().reconcileAdmissionWrite(lossy)).resolves.toBe('unknown');
    await expect(ledger().reconcileObservationWrite(lossy, etag)).resolves.toBe('unknown');
  }
  const next = { ...op, operationId: 'legacy-bytes-next', partNumber: 2 };
  await ledger().recordAdmission(next);
  expect(await rows(`SELECT hex(intent_id) AS intent, hex(owner_id) AS owner, hex(object_key) AS key,
    hex(upload_id) AS upload FROM ${operations} WHERE operation_id = ?`, next.operationId))
    .toEqual([{ intent: '610080', owner: '6281', key: '6382', upload: '6483' }]);
});

it('cannot replace an operation or observation through SQLite conflict policies', async () => {
  const op = operation('immutable-part');
  await migrate();
  await seed(op);
  for (const [id, epoch] of [["CAST(x'80' AS TEXT)", '?'], ['?', "CAST(x'80' AS TEXT)"]]) {
    await expect(run(`INSERT INTO ${operations} SELECT ${id}, id, owner_id, object_key, ${epoch}, upload_id,
      version, 1, 5 FROM drive_upload_intents WHERE id = ?`, epoch === '?' ? op.storageEpoch : op.operationId, op.intentId))
      .rejects.toThrow('CHECK constraint failed');
  }
  await ledger().recordAdmission(op);
  await expect(run(`INSERT OR IGNORE INTO ${observations} VALUES (?, 'reported', CAST(x'80' AS TEXT))`, op.operationId))
    .rejects.toThrow(/invalid or duplicate|cannot store TEXT/);
  for (const [kind, value] of [['reported', "x''"], ['reported', 'zeroblob(8193)'],
    ['uncertain', "x'80'"], ['other', 'NULL']]) {
    await expect(run(`INSERT OR IGNORE INTO ${observations} VALUES (?, ?, ${value})`, op.operationId, kind))
      .rejects.toThrow('invalid or duplicate');
  }
  await ledger().recordObservation(op, etag);
  for (const policy of ['', 'OR ABORT', 'OR IGNORE', 'OR REPLACE', 'OR FAIL', 'OR ROLLBACK']) {
    for (const [id, part] of [["'alias'", 'part_number'], ['operation_id', 'part_number + 1']]) {
      await expect(run(`INSERT ${policy} INTO ${operations} SELECT ${id}, intent_id, owner_id, object_key,
        storage_epoch, upload_id, intent_version, ${part}, size_bytes FROM ${operations} WHERE operation_id = ?`, op.operationId))
        .rejects.toThrow('invalid or duplicate');
    }
    for (const id of [op.operationId, 'absent']) {
      await expect(run(`INSERT ${policy} INTO ${observations} VALUES (?, 'reported', x'01')`, id))
        .rejects.toThrow('invalid or duplicate');
    }
    await expect(run(`UPDATE ${policy} ${operations} SET size_bytes = 0 WHERE operation_id = ?`, op.operationId))
      .rejects.toThrow('immutable');
    await expect(run(`UPDATE ${policy} ${observations} SET reported_etag = x'01' WHERE operation_id = ?`, op.operationId))
      .rejects.toThrow('immutable');
  }
  await expect(run(`INSERT INTO ${observations} VALUES (?, 'reported', x'01')
    ON CONFLICT (operation_id, kind) DO UPDATE SET reported_etag = excluded.reported_etag`, op.operationId))
    .rejects.toThrow('invalid or duplicate');
  for (const table of [observations, operations]) {
    await expect(run(`DELETE FROM ${table} WHERE operation_id = ?`, op.operationId)).rejects.toThrow('permanent');
  }
  await expect(ledger().reconcileObservationWrite(op, etag)).resolves.toBe('recorded');
  const oversized = new Uint8Array(8193);
  Object.defineProperty(oversized, 'byteLength', { value: 1 });
  await expect(ledger().recordObservation(op, oversized)).rejects.toThrow('Invalid reported part ETag');
  await expect(ledger().reconcileObservationWrite(op, new Uint16Array([1]))).rejects.toThrow('Invalid reported part ETag');
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
  expect(await rows(`SELECT hex(reported_etag) AS etag FROM ${observations}
    WHERE operation_id = ? AND kind = 'reported'`, op.operationId))
    .toEqual([{ etag: '2280FF22' }]);
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
  await expect(reconciler.reconcileObservationWrite(op, new Uint8Array([0x22, 0x80, 0xfe, 0x22]))).resolves.toBe('conflict');
  await expect(reconciler.reconcileObservationWrite(op, null)).resolves.toBe('recorded');
  await expect(insertIntent({ ...op, objectKey: 'alternate-key' })).rejects.toThrow('upload intent ID already reserved');
  expect(await rows("SELECT id FROM drive_upload_intents WHERE id = 'intent-late-part'")).toEqual([]);
  expect(await rows("SELECT id FROM drive_active_members WHERE id = 'owner-late-part'")).toEqual([]);
  for (const table of ['drive_entries', 'drive_read_grants', 'drive_upload_completion_evidence']) {
    expect(await rows(`SELECT * FROM ${table}`)).toEqual([]);
  }
});
