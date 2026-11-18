import { env } from 'cloudflare:workers';
import { applyD1Migrations } from '@cloudflare/vitest-plugin';
import { expect, it, vi } from 'vitest';
import { PrivateDeletion } from '../../drive/src/lib/server/metadata/private-deletion.ts';
import { UploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { createTrustedUploadPublication } from '../../drive/src/lib/server/metadata/upload-trusted-publication.ts';
import { config, epoch, evidence, intentRow, migrations, parts, producer, response, seed, sessions, sql } from './fixtures/upload-completion.mjs';

const etag = '"final-opaque"';
const configId = JSON.stringify([config.endpoint, config.bucket, epoch]);
const qualified = async (id) => id === configId;
const headOk = () => new Response(null, { headers: { etag, 'content-length': '7' } });
const publisher = (fetch, qualify = qualified, s3 = config, storageEpoch = epoch) =>
  createTrustedUploadPublication(env.DB, storageEpoch, s3, { fetch, timeoutMs: 5000 }, qualify);
const generations = () => sql('SELECT * FROM drive_published_generations').all().then(({ results }) => results);

async function setup(operation, options = {}) {
  await applyD1Migrations(env.DB, migrations);
  const { token, key, intent, part } = await seed(operation, { declaredSize: 7, ...options });
  const owner = `owner-${operation}`;
  const complete = producer(async () => response(key));
  return { token, key, intent, owner, part, complete: () => complete.complete(token, operation),
    publish: (service, version = 3, auth = token) => service.publish(auth, owner, intent, version, operation, null, 'file') };
}

it('publishes the signed, conditionally verified receipt and retains the generation after entry and intent removal', async () => {
  const operation = 'published', key = `${String.fromCodePoint(0xfeff)}dir/exact key`;
  const { publish, complete, token, owner, intent } = await setup(operation, { key });
  expect(await complete()).toBe('recorded');
  const receipt = await evidence('receipts', operation);
  const head = vi.fn(async (request) => {
    expect(request.method).toBe('HEAD');
    expect(request.url).toBe(`${config.endpoint}/${config.bucket}/%EF%BB%BFdir/exact%20key`);
    expect(request.headers.get('if-match')).toBe(etag);
    expect(request.headers.get('authorization')).toMatch(/SignedHeaders=[^,]*if-match/);
    return headOk();
  });
  // Canonicalize the endpoint before both qualification and signing.
  const service = publisher(head, qualified, { ...config, endpoint: `${config.endpoint}/` });
  const { id } = await publish(service);
  expect(await intentRow(intent)).toMatchObject({ state: 'acknowledged', version: 4, completion_acknowledged: 1 });
  expect(await sql('SELECT completion_operation_id, evidence_revision FROM drive_upload_publications WHERE entry_id = ?', id).first())
    .toEqual({ completion_operation_id: operation, evidence_revision: receipt.evidence_revision });
  const generation = { entry_id: id, intent_id: intent, owner_id: owner, object_key: key,
    endpoint: config.endpoint, bucket: config.bucket, storage_epoch: epoch, etag, size_bytes: 7, evidence_revision: receipt.evidence_revision };
  expect(await generations()).toEqual([generation]);
  expect(await publish(service)).toBeNull();
  expect(head).toHaveBeenCalledTimes(1);
  expect(await new PrivateDeletion(env.DB).delete(token, id)).toBe(true);
  await sql('DELETE FROM drive_upload_intents WHERE id = CAST(? AS TEXT)', intent).run();
  expect(await generations()).toEqual([generation]);
  expect(await evidence('receipts', operation)).toEqual(receipt);
});

it('does not infer or retrofit a storage generation on a legacy publication', async () => {
  await applyD1Migrations(env.DB, migrations.filter(({ name }) => name < '0030'));
  const operation = 'legacy-publication', { token, intent } = await seed(operation, { declaredSize: 7 });
  const legacy = new UploadPublication(env.DB, async () => ({ etag, size: 7 }), token);
  expect(await legacy.completeAndPublish(`owner-${operation}`, intent, 2, null, 'legacy', parts)).not.toBeNull();
  await applyD1Migrations(env.DB, migrations);
  expect(await sql('SELECT completion_operation_id, evidence_revision FROM drive_upload_publications').first())
    .toEqual({ completion_operation_id: null, evidence_revision: null });
  expect(await generations()).toEqual([]);
});

it('denies missing qualification, qualification for another provider, and each storage binding mismatch before HEAD', async () => {
  const { publish, complete } = await setup('wrong-storage');
  expect(await complete()).toBe('recorded');
  const head = vi.fn(headOk);
  const unqualified = createTrustedUploadPublication(env.DB, epoch, config, { fetch: head });
  expect(await publish(unqualified)).toBeNull();
  expect(await publish(publisher(head, async (id) => id === JSON.stringify(['https://other.example', config.bucket, epoch])))).toBeNull();
  for (const [s3, version] of [[{ ...config, endpoint: 'https://other.example' }, epoch],
    [{ ...config, bucket: 'other-bucket' }, epoch], [config, 'old-epoch']]) {
    expect(await publish(publisher(head, async () => true, s3, version))).toBeNull();
  }
  expect(head).not.toHaveBeenCalled();
  expect(await generations()).toEqual([]);
});

it('rejects a stale version and a valid session from another principal before HEAD', async () => {
  const { publish, complete } = await setup('not-owner');
  const other = await seed('other-principal');
  expect(await complete()).toBe('recorded');
  const head = vi.fn(headOk);
  const service = publisher(head);
  expect(await publish(service, 2)).toBeNull();
  expect(await publish(service, 3, other.token)).toBeNull();
  expect(head).not.toHaveBeenCalled();
  expect(await generations()).toEqual([]);
});

it('rejects a bare seal, an unresolved dispatch and a late receipt on a quarantined dispatch', async () => {
  const operation = 'late-completion';
  const { publish, token, key } = await setup(operation);
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
  expect(await generations()).toEqual([]);
});

it.each([[412, etag, '7'], [200, '"different"', '7'], [200, etag, '8'], [200, etag, null]])(
  'denies HEAD status %s, ETag %s, length %s unless all match', async (status, tag, size) => {
    const { publish, complete } = await setup('head-mismatch');
    expect(await complete()).toBe('recorded');
    const headers = { etag: tag, ...(size === null ? {} : { 'content-length': size }) };
    const head = vi.fn(() => new Response(null, { status, headers }));
    expect(await publish(publisher(head))).toBeNull();
    expect(head).toHaveBeenCalledTimes(1);
    expect(await generations()).toEqual([]);
  });

it.each([
  ['session revocation', ({ token }) => sessions.revoke(token)],
  ['membership revocation', ({ owner }) => sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", owner).run()],
  ['journal version change', ({ intent }) => sql('UPDATE drive_upload_intents SET version = 4 WHERE id = CAST(? AS TEXT)', intent).run()],
  ['journal upload ID change', ({ intent }) => sql("UPDATE drive_upload_intents SET upload_id = 'different' WHERE id = CAST(? AS TEXT)", intent).run()],
  ['tombstone', ({ intent }) => sql('INSERT INTO drive_upload_publication_tombstones VALUES (CAST(? AS TEXT))', intent).run()],
  ['late part uncertainty', ({ part }) => sql("INSERT INTO drive_upload_part_observations VALUES (?, 'uncertain', NULL)", part).run()],
])('rechecks %s in the publication write after a matching HEAD', async (_label, race) => {
  const fixture = await setup('publication-race');
  expect(await fixture.complete()).toBe('recorded');
  const head = vi.fn(async () => { await race(fixture); return headOk(); });
  expect(await fixture.publish(publisher(head))).toBeNull();
  expect(head).toHaveBeenCalledTimes(1);
  expect(await generations()).toEqual([]);
  expect(await sql('SELECT id FROM drive_entries').first()).toBeNull();
});

it('requires the exact durable revision even when the rest of the insert matches', async () => {
  const operation = 'wrong-revision';
  const { complete, key, owner, intent } = await setup(operation);
  expect(await complete()).toBe('recorded');
  await expect(sql(`INSERT INTO drive_upload_publications
    (intent_id, intent_version, entry_id, owner_id, object_key, name, size_bytes, object_etag, completion_operation_id, evidence_revision)
    VALUES (CAST(? AS TEXT), 3, 'entry', ?, ?, 'file', 7, ?, ?, ?)`, intent, owner, key, etag, operation, crypto.randomUUID()).run())
    .rejects.toThrow(/publication not admitted/);
  expect(await generations()).toEqual([]);
});
