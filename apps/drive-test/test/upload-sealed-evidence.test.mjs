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

async function seed(id, { missing = false, uncertain = false, otherEpoch = false } = {}) {
  const operation = { operationId: `complete-${id}`, intentId: `intent-${id}`, ownerId: `owner-${id}`,
    objectKey: `key-${id}`, storageEpoch: 'epoch-1', uploadId: `upload-${id}`, intentVersion: 2 };
  await run("INSERT INTO drive_principals VALUES (?, 'member', 'active')", operation.ownerId);
  await run(`INSERT INTO ${journal} (id, owner_id, object_key, upload_id, state, version)
    VALUES (?, ?, ?, ?, 'allocated', 2)`, operation.intentId, operation.ownerId, operation.objectKey, operation.uploadId);
  await completion.recordOperation(operation);
  const parts = [{ operationId: `part-${id}-1`, partNumber: 1, etag: '"<&é\\>"', size: 5242880 },
    { operationId: `part-${id}-3`, partNumber: 3, etag: '"opaque"', size: 1 }];
  // Store observations out of order; the snapshot order comes from the manifest.
  for (const part of [...parts].reverse()) {
    const op = { ...operation, ...part, sizeBytes: part.size, storageEpoch: otherEpoch ? 'epoch-2' : operation.storageEpoch };
    await ledger.recordAdmission(op);
    if (!missing || part.partNumber === 1) await ledger.recordObservation(op, utf8.encode(part.etag));
    if (uncertain) await ledger.recordObservation(op, null);
  }
  return { operation, parts, sizeBytes: 5242881 };
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
  const [first, last] = snapshot.parts;
  await expect(sealed.recordSnapshot({ ...snapshot, sizeBytes: 0 })).rejects.toThrow('Invalid upload manifest size');
  await expect(sealed.recordSnapshot({ ...snapshot, parts: [last, first] })).rejects.toThrow('Invalid multipart part order');
  for (const changed of [{ etag: '"<%é\\>"' }, { operationId: 'different-part' }, { size: 0 }, { partNumber: 2 }]) {
    await expect(sealed.recordSnapshot({ ...snapshot, parts: [first, { ...last, ...changed }], sizeBytes: first.size + (changed.size ?? last.size) }))
      .rejects.toThrow('invalid or duplicate');
  }
  await expect(sealed.recordSnapshot({ ...snapshot, parts: [first], sizeBytes: first.size })).rejects.toThrow('invalid or duplicate');
  for (const state of [{ missing: true }, { uncertain: true }, { otherEpoch: true }]) {
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
  expect(await rows(`SELECT manifest FROM ${snapshots} WHERE operation_id = 'complete-exact'`))
    .toEqual([{ manifest: JSON.stringify(snapshot.parts) }]);
  expect(await rows(`SELECT * FROM ${journal} ORDER BY id`)).toEqual(before);
  // Sealing observations is not an all-caller fence; the legacy writer is unchanged.
  await run(`UPDATE ${journal} SET state = 'completing', version = 3 WHERE id = ?`, snapshot.operation.intentId);
});

it('rejects replacing, mutating or deleting a sealed snapshot or report', async () => {
  await migrate();
  const snapshot = await seed('conflict');
  const insert = `INTO ${snapshots} (operation_id, manifest, size_bytes) VALUES (?, ?, ?)`;
  await expect(run(`INSERT ${insert}`, snapshot.operation.operationId, JSON.stringify([...snapshot.parts].reverse()), snapshot.sizeBytes))
    .rejects.toThrow('invalid or duplicate');
  await sealed.recordSnapshot(snapshot);
  await sealed.recordUnverifiedReport(snapshot, report);
  for (const policy of ['', 'OR IGNORE', 'OR REPLACE', 'OR FAIL', 'OR ROLLBACK']) {
    await expect(run(`INSERT ${policy} ${insert}`, snapshot.operation.operationId, JSON.stringify(snapshot.parts), snapshot.sizeBytes))
      .rejects.toThrow('invalid or duplicate');
    await expect(run(`INSERT ${policy} INTO ${reports} VALUES (?, x'01')`, snapshot.operation.operationId))
      .rejects.toThrow('invalid or duplicate');
  }
  for (const table of [reports, snapshots]) {
    await expect(run(`UPDATE ${table} SET operation_id = 'replacement'`)).rejects.toThrow('immutable');
    await expect(run(`DELETE FROM ${table}`)).rejects.toThrow('permanent');
  }
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
  const mismatch = { ...snapshot, parts: [snapshot.parts[0], { ...snapshot.parts[1], etag: '"different"' }] };
  await expect(reconciler.reconcileSnapshotWrite(snapshot)).resolves.toBe('recorded');
  await expect(reconciler.reconcileSnapshotWrite(mismatch)).resolves.toBe('conflict');
  await expect(sealed.recordUnverifiedReport(mismatch, report)).rejects.toThrow('No matching sealed upload snapshot');
  await expect(reconciler.reconcileReportWrite(snapshot, report)).resolves.toBe('unknown');
  expect(await rows(`SELECT * FROM ${journal} WHERE id = 'intent-lost-ack'`)).toEqual(before);
  await run(`DELETE FROM ${journal} WHERE id = ?`, snapshot.operation.intentId);
  const part = snapshot.parts[0];
  await ledger.recordObservation({ ...snapshot.operation, ...part, sizeBytes: part.size }, null);
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
