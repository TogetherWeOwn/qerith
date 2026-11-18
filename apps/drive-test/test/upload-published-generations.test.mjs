import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { PrivateDeletion } from '../../drive/src/lib/server/metadata/private-deletion.ts';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { UploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { createTrustedUploadPublication } from '../../drive/src/lib/server/metadata/upload-trusted-publication.ts';
import { config, epoch, evidence, intentRow, migrations, parts, preGenerationMigrations, producer, response, seed, sessions, sql } from './fixtures/upload-completion.mjs';
import { etag, headOk, publisher, qualified, seedBoundPublication, setup } from './fixtures/upload-publication-generation.mjs';

const generationFor = (intent) => sql('SELECT * FROM drive_published_generations WHERE intent_id = CAST(? AS TEXT)', intent).first();

// Exercise the upgrade before another test in this file applies 0030.
it('does not infer or retrofit a storage generation on a legacy publication', async () => {
  await applyD1Migrations(env.DB, preGenerationMigrations);
  const operation = 'legacy-publication', { token, intent } = await seed(operation, { declaredSize: 7 });
  const legacy = new UploadPublication(env.DB, async () => ({ etag, size: 7 }), token);
  const { id } = await legacy.completeAndPublish(`owner-${operation}`, intent, 2, null, 'legacy', parts);
  await applyD1Migrations(env.DB, migrations);
  expect(await sql('SELECT completion_operation_id, evidence_revision FROM drive_upload_publications WHERE entry_id = ?', id).first())
    .toEqual({ completion_operation_id: null, evidence_revision: null });
  expect(await generationFor(intent)).toBeNull();
});

it('publishes the signed, conditionally verified receipt and retains the generation after entry and intent removal', async () => {
  const operation = 'published', owner = `owner-${operation}`;
  const head = vi.fn(async (request) => {
    expect(request.method).toBe('HEAD');
    expect(request.url).toBe(`${config.endpoint}/${config.bucket}/%EF%BB%BFdir/exact%20key`);
    expect(request.headers.get('if-match')).toBe(etag);
    expect(request.headers.get('authorization')).toMatch(/SignedHeaders=[^,]*if-match/);
    return headOk();
  });
  // Canonicalize the endpoint before both qualification and signing.
  const service = publisher(head, qualified, { ...config, endpoint: `${config.endpoint}/` });
  const { id, token, key, intent, evidenceRevision } = await seedBoundPublication(operation, { service, key: `${String.fromCodePoint(0xfeff)}dir/exact key` });
  const receipt = await evidence('receipts', operation);
  expect(await intentRow(intent)).toMatchObject({ state: 'acknowledged', version: 4, completion_acknowledged: 1 });
  expect(await sql('SELECT completion_operation_id, evidence_revision FROM drive_upload_publications WHERE entry_id = ?', id).first())
    .toEqual({ completion_operation_id: operation, evidence_revision: evidenceRevision });
  const generation = { entry_id: id, intent_id: intent, owner_id: owner, object_key: key,
    endpoint: config.endpoint, bucket: config.bucket, storage_epoch: epoch, etag, size_bytes: 7, evidence_revision: evidenceRevision };
  expect(await generationFor(intent)).toEqual(generation);
  expect(await service.publish(token, owner, intent, 3, operation, null, 'file')).toBeNull();
  expect(head).toHaveBeenCalledTimes(1);
  expect(await new PrivateDeletion(env.DB).delete(token, id)).toBe(true);
  await sql('DELETE FROM drive_upload_intents WHERE id = CAST(? AS TEXT)', intent).run();
  expect(await generationFor(intent)).toEqual(generation);
  expect(await evidence('receipts', operation)).toEqual(receipt);
});

it('denies missing qualification, qualification for another provider, and each storage binding mismatch before HEAD', async () => {
  const { publish, complete, intent } = await setup('wrong-storage');
  expect(await complete()).toBe('recorded');
  const head = vi.fn(headOk);
  const unqualified = createTrustedUploadPublication(env.DB, epoch, config, { fetch: head, timeoutMs: 5000 });
  expect(await publish(unqualified)).toBeNull();
  expect(await publish(publisher(head, async (id) => id === JSON.stringify(['https://other.example', config.bucket, epoch])))).toBeNull();
  for (const [s3, version] of [[{ ...config, endpoint: 'https://other.example' }, epoch],
    [{ ...config, bucket: 'other-bucket' }, epoch], [config, 'old-epoch']]) {
    expect(await publish(publisher(head, async () => true, s3, version))).toBeNull();
  }
  expect(head).not.toHaveBeenCalled();
  expect(await generationFor(intent)).toBeNull();
});

it('rejects a stale version and a valid session from another principal before HEAD', async () => {
  const { publish, complete, intent } = await setup('not-owner');
  const other = await seed('other-principal');
  expect(await complete()).toBe('recorded');
  const head = vi.fn(headOk);
  const service = publisher(head);
  expect(await publish(service, 2)).toBeNull();
  expect(await publish(service, 3, other.token)).toBeNull();
  expect(head).not.toHaveBeenCalled();
  expect(await generationFor(intent)).toBeNull();
});

it('rejects a bare seal, an unresolved dispatch and a late receipt on a quarantined dispatch', async () => {
  const operation = 'late-completion';
  const { publish, token, key, intent } = await setup(operation);
  const head = vi.fn(headOk);
  const service = publisher(head);
  expect(await publish(service)).toBeNull();
  const completion = producer(async () => {
    expect(await publish(service)).toBeNull();
    await completion.quarantineUnresolved(operation);
    return response(key);
  });
  expect(await completion.complete(token, operation)).toBe('recorded');
  expect(await evidence('receipts', operation)).not.toBeNull();
  expect(await evidence('quarantine', operation)).not.toBeNull();
  expect(await publish(service)).toBeNull();
  expect(head).not.toHaveBeenCalled();
  expect(await generationFor(intent)).toBeNull();
});

it.each([['status', 412, etag, '7'], ['etag', 200, '"different"', '7'], ['size', 200, etag, '8'], ['missing-size', 200, etag, null]])(
  'denies HEAD %s mismatch (HTTP %s, ETag %s, length %s)', async (label, status, tag, size) => {
    const { publish, complete, intent } = await setup(`head-mismatch-${label}`);
    expect(await complete()).toBe('recorded');
    const headers = { etag: tag, ...(size === null ? {} : { 'content-length': size }) };
    const head = vi.fn(() => new Response(null, { status, headers }));
    expect(await publish(publisher(head))).toBeNull();
    expect(head).toHaveBeenCalledTimes(1);
    expect(await generationFor(intent)).toBeNull();
  });

it.each([
  ['session revocation', ({ token }) => sessions.revoke(token)],
  ['membership revocation', ({ owner }) => sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", owner).run()],
  ['journal version change', ({ intent }) => sql('UPDATE drive_upload_intents SET version = 4 WHERE id = CAST(? AS TEXT)', intent).run()],
  ['journal upload ID change', ({ intent }) => sql("UPDATE drive_upload_intents SET upload_id = 'different' WHERE id = CAST(? AS TEXT)", intent).run()],
  ['tombstone', ({ intent }) => sql('INSERT INTO drive_upload_publication_tombstones VALUES (CAST(? AS TEXT))', intent).run()],
  ['late part uncertainty', ({ part }) => sql("INSERT INTO drive_upload_part_observations VALUES (?, 'uncertain', NULL)", part).run()],
])('rechecks %s in the publication write after a matching HEAD', async (label, race) => {
  const fixture = await setup(`publication-race-${label.replaceAll(' ', '-')}`);
  expect(await fixture.complete()).toBe('recorded');
  const head = vi.fn(async () => { await race(fixture); return headOk(); });
  expect(await fixture.publish(publisher(head))).toBeNull();
  expect(head).toHaveBeenCalledTimes(1);
  expect(await generationFor(fixture.intent)).toBeNull();
  expect(await sql('SELECT id FROM drive_entries WHERE owner_id = ?', fixture.owner).first()).toBeNull();
});

it('keeps legacy recovery from settling a trusted dispatch between HEAD and publication', async () => {
  const { complete, owner, intent, publish } = await setup('legacy-race', { intent: 'legacy-race-intent' });
  expect(await complete()).toBe('recorded');
  const legacy = new UploadIntents(env.DB);
  const head = async () => {
    expect(await legacy.listInFlight('', 10)).not.toContainEqual(expect.objectContaining({ id: intent }));
    expect(await legacy.recordUncertain(owner, intent, 3, 'completion')).toBe(false);
    expect(await legacy.recordNotDispatched(owner, intent, 3, 'completion')).toBe(false);
    expect(await legacy.recordSuccess(owner, intent, 3, { kind: 'completion' })).toBe(false);
    await expect(sql(`UPDATE drive_upload_intents SET state = 'acknowledged', completion_acknowledged = 1,
      version = 4 WHERE id = ?`, intent).run()).rejects.toThrow(/trusted dispatch requires atomic publication/);
    return headOk();
  };
  const { id } = await publish(publisher(head));
  expect(await generationFor(intent)).toMatchObject({ entry_id: id });
});

it('requires the exact durable revision even when the rest of the insert matches', async () => {
  const operation = 'wrong-revision';
  const { complete, key, owner, intent } = await setup(operation);
  expect(await complete()).toBe('recorded');
  await expect(sql(`INSERT INTO drive_upload_publications
    (intent_id, intent_version, entry_id, owner_id, object_key, name, size_bytes, object_etag, completion_operation_id, evidence_revision)
    VALUES (CAST(? AS TEXT), 3, 'entry', ?, ?, 'file', 7, ?, ?, ?)`, intent, owner, key, etag, operation, crypto.randomUUID()).run())
    .rejects.toThrow(/publication not admitted/);
  expect(await generationFor(intent)).toBeNull();
});
