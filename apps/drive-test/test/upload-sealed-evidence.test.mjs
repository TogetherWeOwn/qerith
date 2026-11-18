import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadOperationEvidence } from '../../drive/src/lib/server/metadata/upload-operation-evidence.ts';
import { UploadPartOperationEvidence } from '../../drive/src/lib/server/metadata/upload-part-operation-evidence.ts';
import { UploadSealedEvidence } from '../../drive/src/lib/server/metadata/upload-sealed-evidence.ts';

const migration = '0021_upload_sealed_evidence.sql';
const migrate = (limit = migration) => applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name <= limit));
const run = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const rows = async (sql) => (await env.DB.prepare(sql).all()).results;
const journal = 'drive_upload_intents';
const snapshots = 'drive_upload_sealed_snapshots';
const reports = 'drive_upload_sealed_reports';
const completion = new UploadOperationEvidence(env.DB);
const ledger = new UploadPartOperationEvidence(env.DB);
const sealed = new UploadSealedEvidence(env.DB);
const report = new Uint8Array([99, 0, 255, 99]).subarray(1, 3);
const utf8 = new TextEncoder();

async function seed(id, { missing = false, uncertain = false, otherEpoch = false, short = false, operationId = `complete-${id}` } = {}) {
  const operation = { operationId, intentId: `intent-${id}`, ownerId: `owner-${id}`,
    objectKey: `key-${id}`, storageEpoch: 'epoch-1', uploadId: `upload-${id}`, intentVersion: 2 };
  await run("INSERT INTO drive_principals VALUES (?, 'member', 'active')", operation.ownerId);
  await run(`INSERT INTO ${journal} (id, owner_id, object_key, upload_id, state, version)
    VALUES (?, ?, ?, ?, 'allocated', 2)`, operation.intentId, operation.ownerId, operation.objectKey, operation.uploadId);
  await completion.recordOperation(operation);
  const firstSize = short ? 1 : 5242880;
  // Store observations out of order, with both arbitrary octets and UTF-8 tags.
  for (const [partNumber, sizeBytes, tag] of [[3, 1, utf8.encode('"opaque"')],
    [1, firstSize, new Uint8Array([0x22, 0x80, 0xff, 0x22])]]) {
    const op = { ...operation, operationId: `part-${id}-${partNumber}`, partNumber,
      sizeBytes, storageEpoch: otherEpoch ? 'epoch-2' : operation.storageEpoch };
    await ledger.recordAdmission(op);
    if (!missing || partNumber === 1) await ledger.recordObservation(op, tag);
    if (uncertain) await ledger.recordObservation(op, null);
  }
  return { operation, partNumbers: [1, 3], sizeBytes: firstSize + 1 };
}

it('upgrades 0020 without inferring a snapshot or sealed report from legacy acknowledgements or observations', async () => {
  await migrate('0020_upload_part_operation_evidence.sql');
  const snapshot = await seed('legacy');
  await run(`UPDATE ${journal} SET state = 'acknowledged', completion_acknowledged = 1 WHERE id = ?`, snapshot.operation.intentId);
  await completion.storeUnverifiedReceipt(snapshot.operation, report);
  const before = await rows(`SELECT * FROM ${journal}`);
  await migrate();
  await migrate();
  expect(await rows(`SELECT * FROM ${journal}`)).toEqual(before);
  expect(await rows(`SELECT * FROM ${snapshots}`)).toEqual([]);
  expect(await rows(`SELECT * FROM ${reports}`)).toEqual([]);
  await expect(sealed.recordSnapshot(snapshot)).rejects.toThrow('invalid or duplicate');
  await expect(sealed.reconcileReportWrite(snapshot, report)).resolves.toBe('unknown');
});

it('seals only complete, ordered and exact observations for the live allocation', async () => {
  await migrate();
  const snapshot = await seed('exact');
  for (const field of Object.keys(snapshot.operation)) {
    const mismatch = { ...snapshot, operation: { ...snapshot.operation, [field]: field === 'intentVersion' ? 3 : 'wrong' } };
    await expect(sealed.recordSnapshot(mismatch)).rejects.toThrow('No matching upload completion operation');
  }
  await expect(sealed.recordSnapshot({ ...snapshot, sizeBytes: 0 })).rejects.toThrow('invalid or duplicate');
  await expect(sealed.recordSnapshot({ ...snapshot, partNumbers: [3, 1] })).rejects.toThrow('Invalid sealed upload part order');
  await expect(sealed.recordSnapshot({ ...snapshot, partNumbers: [1, 2] })).rejects.toThrow('invalid or duplicate');
  await expect(sealed.recordSnapshot({ ...snapshot, partNumbers: [1], sizeBytes: 5242880 })).rejects.toThrow('invalid or duplicate');
  for (const state of [{ missing: true }, { uncertain: true }, { otherEpoch: true }, { short: true }]) {
    const invalid = await seed(Object.keys(state)[0], state);
    await expect(sealed.recordSnapshot(invalid)).rejects.toThrow('invalid or duplicate');
  }
  const stale = await seed('stale');
  await run(`UPDATE ${journal} SET version = 3 WHERE id = ?`, stale.operation.intentId);
  await expect(sealed.recordSnapshot(stale)).rejects.toThrow('invalid or duplicate');
  const revoked = await seed('revoked');
  await run("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", revoked.operation.ownerId);
  await expect(sealed.recordSnapshot(revoked)).rejects.toThrow('invalid or duplicate');
  const previouslyReported = await seed('prior-report');
  await completion.storeUnverifiedReceipt(previouslyReported.operation, report);
  await expect(sealed.recordSnapshot(previouslyReported)).rejects.toThrow('invalid or duplicate');
  const before = await rows(`SELECT * FROM ${journal} ORDER BY id`);
  const attempts = await Promise.allSettled([sealed.recordSnapshot(snapshot), sealed.recordSnapshot(snapshot)]);
  expect(attempts.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
  expect(await rows(`SELECT p.operation_id, hex(r.reported_etag) AS tag, p.size_bytes
    FROM ${snapshots} s JOIN drive_upload_completion_operations o USING (operation_id)
    JOIN json_each(s.part_numbers) slot
    JOIN drive_upload_part_operations p ON p.intent_id = o.intent_id AND p.part_number = slot.value
    JOIN drive_upload_part_observations r ON r.operation_id = p.operation_id AND r.kind = 'reported'
    WHERE s.operation_id = 'complete-exact' ORDER BY slot.key`)).toEqual([
    { operation_id: 'part-exact-1', tag: '2280FF22', size_bytes: 5242880 },
    { operation_id: 'part-exact-3', tag: '226F706171756522', size_bytes: 1 },
  ]);
  expect(await rows(`SELECT * FROM ${journal} ORDER BY id`)).toEqual(before);
  // Later observations are still possible but do not join the sealed slot list.
  const latePart = { ...snapshot.operation, operationId: 'part-exact-4', partNumber: 4, sizeBytes: 0 };
  await ledger.recordAdmission(latePart);
  await ledger.recordObservation(latePart, utf8.encode('"late"'));
  await expect(sealed.reconcileSnapshotWrite(snapshot)).resolves.toBe('recorded');
  await expect(sealed.reconcileSnapshotWrite({ ...snapshot, partNumbers: [1, 3, 4] })).resolves.toBe('conflict');
  // Sealing observations is not an all-caller fence; the legacy writer is unchanged.
  await run(`UPDATE ${journal} SET state = 'completing', version = 3 WHERE id = ?`, snapshot.operation.intentId);
});

it('rejects replacing, mutating or deleting a sealed snapshot or report', async () => {
  await migrate();
  const snapshot = await seed('conflict');
  const insert = `INTO ${snapshots} (operation_id, part_numbers, size_bytes) VALUES (?, ?, ?)`;
  for (const noncanonical of ['[3,1]', '[1, 3]', '["1","3"]', '[1.0,3]', '[1,1,3]'])
    await expect(run(`INSERT ${insert}`, snapshot.operation.operationId, noncanonical, snapshot.sizeBytes))
      .rejects.toThrow('invalid or duplicate');
  await sealed.recordSnapshot(snapshot);
  await sealed.recordUnverifiedReport(snapshot, report);
  for (const policy of ['', 'OR IGNORE', 'OR REPLACE', 'OR FAIL', 'OR ROLLBACK']) {
    await expect(run(`INSERT ${policy} ${insert}`, snapshot.operation.operationId, '[1,3]', snapshot.sizeBytes))
      .rejects.toThrow('invalid or duplicate');
    await expect(run(`INSERT ${policy} INTO ${reports} VALUES (?, x'01')`, snapshot.operation.operationId))
      .rejects.toThrow('invalid or duplicate');
  }
  for (const table of [reports, snapshots]) {
    await expect(run(`UPDATE ${table} SET operation_id = 'replacement'`)).rejects.toThrow('immutable');
    await expect(run(`DELETE FROM ${table}`)).rejects.toThrow('permanent');
  }
});

it('enforces the same identity byte bound in SQL and the server API', async () => {
  await migrate();
  const operationId = '界'.repeat(65536);
  const bounded = await seed('bounded', { operationId });
  await sealed.recordSnapshot(bounded);
  await expect(sealed.reconcileSnapshotWrite(bounded)).resolves.toBe('recorded');
  const oversized = await seed('oversized', { operationId: `${operationId}x` });
  await expect(sealed.recordSnapshot(oversized)).rejects.toThrow('Invalid sealed upload identity');
  await expect(run(`INSERT INTO ${snapshots} (operation_id, part_numbers, size_bytes) VALUES (?, '[1,3]', ?)`,
    oversized.operation.operationId, oversized.sizeBytes)).rejects.toThrow('invalid or duplicate');
});

it('binds all 10000 slots and matches inherited identities by exact bytes', async () => {
  await migrate();
  const operation = { operationId: 'complete/large', intentId: 'intent-large', ownerId: 'owner-large',
    objectKey: 'key-large', storageEpoch: 'epoch-1', uploadId: new Uint8Array([0xaa, 0xff, 0xbb]).subarray(1, 2), intentVersion: 2 };
  await run("INSERT INTO drive_principals VALUES ('owner-large', 'member', 'active')");
  await run(`INSERT INTO ${journal} (id, owner_id, object_key, upload_id, state, version)
    VALUES ('intent-large', 'owner-large', 'key-large', CAST(x'ff' AS TEXT), 'allocated', 2)`);
  await run(`INSERT INTO drive_upload_completion_operations VALUES
    ('complete/large', 'intent-large', 'owner-large', 'key-large', 'epoch-1', CAST(x'ff' AS TEXT), 2)`);
  await run(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
    INSERT INTO drive_upload_part_operations SELECT 'large-' || i, 'intent-large', 'owner-large', 'key-large',
      'epoch-1', CAST(x'ff' AS TEXT), 2, i, 5242880 FROM n`);
  await run(`INSERT INTO drive_upload_part_observations SELECT operation_id, 'reported', x'2280ff22'
    FROM drive_upload_part_operations WHERE intent_id = 'intent-large'`);
  const partNumbers = Array.from({ length: 10000 }, (_, i) => i + 1);
  partNumbers[Symbol.iterator] = () => { throw new Error('Unexpected custom iterator'); };
  const snapshot = { operation, partNumbers, sizeBytes: 5242880 * 10000 };
  await expect(sealed.recordSnapshot({ ...snapshot, operation: { ...operation, uploadId: '�' } }))
    .rejects.toThrow('No matching upload completion operation');
  await sealed.recordSnapshot(snapshot);
  await expect(sealed.reconcileSnapshotWrite(snapshot)).resolves.toBe('recorded');
});

it('reconciles committed D1 writes without replaying and retains late reports after revocation and removal', async () => {
  await migrate();
  const snapshot = await seed('lost-ack');
  const lostAck = new UploadSealedEvidence({ prepare: (sql) => ({ bind: (...args) => ({ async first() {
    expect(await env.DB.prepare(sql).bind(...args).first()).toEqual({ operation_id: snapshot.operation.operationId });
    throw new Error('D1 acknowledgement lost');
  } }) }) });
  const reconciler = new UploadSealedEvidence({ withSession(constraint) {
    expect(constraint).toBe('first-primary');
    return env.DB.withSession(constraint);
  } });
  await expect(reconciler.reconcileSnapshotWrite(snapshot)).resolves.toBe('unknown');
  await expect(lostAck.recordSnapshot(snapshot)).rejects.toThrow('D1 acknowledgement lost');
  await run("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", snapshot.operation.ownerId);
  await run(`UPDATE ${journal} SET state = 'uncertain', version = 4 WHERE id = ?`, snapshot.operation.intentId);
  const before = await rows(`SELECT * FROM ${journal} WHERE id = 'intent-lost-ack'`);
  const mismatch = { ...snapshot, partNumbers: [1, 2] };
  await expect(reconciler.reconcileSnapshotWrite(snapshot)).resolves.toBe('recorded');
  await expect(reconciler.reconcileSnapshotWrite(mismatch)).resolves.toBe('conflict');
  await expect(sealed.recordUnverifiedReport(mismatch, report)).rejects.toThrow('No matching sealed upload snapshot');
  await expect(reconciler.reconcileReportWrite(snapshot, report)).resolves.toBe('unknown');
  expect(await rows(`SELECT * FROM ${journal} WHERE id = 'intent-lost-ack'`)).toEqual(before);
  await run(`DELETE FROM ${journal} WHERE id = ?`, snapshot.operation.intentId);
  await ledger.recordObservation({ ...snapshot.operation, operationId: 'part-lost-ack-1', partNumber: 1, sizeBytes: 5242880 }, null);
  await expect(lostAck.recordUnverifiedReport(snapshot, report)).rejects.toThrow('D1 acknowledgement lost');
  await expect(reconciler.reconcileSnapshotWrite(snapshot)).resolves.toBe('recorded');
  await expect(reconciler.reconcileReportWrite(snapshot, report)).resolves.toBe('recorded');
  expect(await rows(`SELECT * FROM ${journal} WHERE id = 'intent-lost-ack'`)).toEqual([]);
  await expect(reconciler.reconcileReportWrite(snapshot, new Uint8Array([0, 254]))).resolves.toBe('conflict');
  await expect(reconciler.reconcileReportWrite(mismatch, report)).resolves.toBe('unknown');
  const outage = new UploadSealedEvidence({ withSession() { throw new Error('primary unavailable'); } });
  await expect(outage.reconcileReportWrite(snapshot, report)).rejects.toThrow('primary unavailable');
  expect(await rows("SELECT * FROM drive_active_members WHERE id = 'owner-lost-ack'")).toEqual([]);
  expect(await rows('SELECT * FROM drive_entries')).toEqual([]);
  expect(await rows('SELECT * FROM drive_read_grants')).toEqual([]);
});
