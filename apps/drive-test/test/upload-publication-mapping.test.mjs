import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { createAtomicUploadPublication } from '../../drive/src/lib/server/metadata/upload-publication.ts';
import { config, epoch, evidence, intentRow, migrations, producer, response, seed, sessions, sql } from './fixtures/upload-completion.mjs';

const migration = '0023_upload_publication_mapping.sql';
const migrate = () => applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name <= migration));
const storageConfigId = JSON.stringify([config.endpoint, config.bucket, epoch]);
const etag = '"final-opaque"';
const head = (size = 7, tag = etag) => new Response(null, { headers: { etag: tag, 'content-length': `${size}` } });
const qualification = { isQualified: async (id) => id === storageConfigId };
const publisher = (fetch, db = env.DB) => createAtomicUploadPublication(db, epoch, config, { fetch, timeoutMs: 5000 }, qualification);
const ref = (id) => env.DB.withSession('first-primary').prepare('SELECT * FROM drive_upload_publication_refs WHERE entry_id = ?').bind(id).first();
const alreadyMapped = (id) => sql('SELECT * FROM drive_upload_publications WHERE operation_id = ?', id).first();
const tombstone = (intent) => sql('INSERT INTO drive_upload_publication_tombstones VALUES (?)', intent).run();
const destination = (id) => ({ entryId: `entry-${id}`, parentId: null, name: `${id}.bin` });

async function completed(id, options) {
  const upload = await seed(id, options);
  await expect(producer(async () => response(upload.key)).complete(upload.token, id)).resolves.toBe('recorded');
  return upload;
}

it('upgrades without backfill, publishes after restart and reconciles an exact lost mapping acknowledgement', async () => {
  await applyD1Migrations(env.DB, migrations);
  const id = 'exact', dest = destination(id), owner = 'owner-exact';
  const { token, key, intent } = await completed(id);
  await sql("INSERT INTO drive_entries VALUES ('entry-legacy', ?, NULL, 'legacy', 'file', 'legacy-key', 7)", owner).run();
  await sql("INSERT INTO drive_entries VALUES ('entry-overlap', ?, NULL, 'overlap', 'file', 'old-overlap', 7)", owner).run();
  const overlap = await completed('overlap', { key: 'old-overlap' });
  await migrate();
  expect(await ref('entry-legacy')).toBeNull();
  const noHead = vi.fn();
  await expect(publisher(noHead).publish(overlap.token, 'overlap', destination('overlap'))).resolves.toBe(false);
  expect(noHead).not.toHaveBeenCalled();
  await expect(seed('legacy-collision', { key: 'legacy-key' })).rejects.toThrow('upload key already names an entry');
  expect(await sql('SELECT object_key FROM drive_upload_intents WHERE object_key = ?', 'legacy-key').first()).toBeNull();
  expect(await sql('SELECT object_key FROM drive_upload_key_reservations WHERE object_key = ?', 'legacy-key').first()).toBeNull();
  await sql("UPDATE drive_entries SET size_bytes = 8 WHERE id = 'entry-legacy'").run();
  expect(await sql("SELECT size_bytes FROM drive_entries WHERE id = 'entry-legacy'").first()).toEqual({ size_bytes: 8 });
  const { evidence_revision } = await evidence('receipts', id);
  for (const policy of ['IGNORE', 'FAIL']) await expect(sql(`INSERT OR ${policy} INTO drive_upload_publications VALUES (?, ?, ?, ?, NULL, ?)`,
    dest.entryId, owner, id, evidence_revision, '.').run()).rejects.toThrow('invalid or duplicate upload publication');
  expect(await alreadyMapped(id)).toBeNull();
  expect(await sql('SELECT id FROM drive_entries WHERE id = ?', dest.entryId).first()).toBeNull();
  expect(await intentRow(intent)).toMatchObject({ state: 'completing', completion_acknowledged: 0, version: 3 });
  const fetch = vi.fn(async (request) => {
    expect(request.method).toBe('HEAD');
    expect(request.url).toBe(`${config.endpoint}/${config.bucket}/${key}`);
    expect(request.headers.get('if-match')).toBe(etag);
    expect(request.headers.get('authorization')).toMatch(/signedheaders=[^,]*if-match/i);
    return head();
  });
  const db = { withSession: (mode) => env.DB.withSession(mode), prepare: (query) => query.startsWith('INSERT INTO drive_upload_publications')
    ? { bind: (...args) => ({ async first() { expect(await sql(query, ...args).first()).not.toBeNull(); throw new Error('lost mapping acknowledgement'); } }) }
    : env.DB.prepare(query) };
  await expect(publisher(fetch, db).publish(token, id, dest)).resolves.toBe(true);
  await expect(sql('UPDATE drive_entries SET size_bytes = 8 WHERE id = ?', dest.entryId).run()).rejects.toThrow('immutable publication size');
  await sql("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES ('move-target', ?, 'folder', 'folder')", owner).run();
  await sql("UPDATE drive_entries SET parent_id = 'move-target', name = 'renamed' WHERE id = ?", dest.entryId).run();
  expect(await ref(dest.entryId)).toEqual({ entry_id: dest.entryId, owner_id: owner, object_key: key, etag,
    size_bytes: 7, storage_config_id: storageConfigId, evidence_revision });
  expect(await intentRow(intent)).toMatchObject({ state: 'acknowledged', completion_acknowledged: 1, version: 4 });
  await expect(publisher(fetch).publish(token, id, dest)).resolves.toBe(true);
  await expect(publisher(fetch).publish(token, id, { ...dest, name: 'different.bin' })).resolves.toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(sql('DELETE FROM drive_entries WHERE id = ?', dest.entryId).run()).rejects.toThrow('not tombstoned');
  await tombstone(intent);
  expect(await ref(dest.entryId)).toBeNull();
  await expect(publisher(fetch).publish(token, id, dest)).resolves.toBe(false);
  await sql('DELETE FROM drive_entries WHERE id = ?', dest.entryId).run();
  await expect(sql("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, 'different', 'folder')", dest.entryId, owner)
    .run()).rejects.toThrow('requires trusted upload publication');
  expect(await alreadyMapped(id)).toMatchObject({ evidence_revision });
  expect(await evidence('receipts', id)).toMatchObject({ evidence_revision });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('denies unqualified, foreign, stale, legacy-acknowledged and generation-mismatched evidence before HEAD', async () => {
  await migrate();
  const id = 'qualified', dest = destination(id), fetch = vi.fn();
  const { token, key, intent } = await completed(id);
  const legacy = await seed('legacy-writer');
  await sql("UPDATE drive_upload_intents SET state = 'acknowledged', completion_acknowledged = 1 WHERE id = ?", legacy.intent).run();
  for (const [settings, generation, verifier] of [
    [config, epoch, undefined], [config, epoch, { isQualified: async () => false }],
    [{ ...config, endpoint: 'https://other.example' }, epoch, { isQualified: async () => true }],
    [{ ...config, bucket: 'another-bucket' }, epoch, { isQualified: async () => true }],
    [config, 'epoch-2', { isQualified: async () => true }],
  ]) await expect(createAtomicUploadPublication(env.DB, generation, settings, { fetch, timeoutMs: 5000 }, verifier)
    .publish(token, id, dest)).resolves.toBe(false);
  await expect(publisher(fetch).publish(legacy.token, 'legacy-writer', destination('legacy-writer'))).resolves.toBe(false);
  await expect(publisher(fetch).publish(legacy.token, id, dest)).resolves.toBe(false);
  const renewed = (await sessions.issue('owner-qualified')).token;
  await expect(publisher(fetch).publish(renewed, id, dest)).resolves.toBe(false);
  await expect(sql("INSERT INTO drive_entries VALUES (?, 'owner-qualified', NULL, ?, 'file', ?, 7)", dest.entryId, dest.name, key)
    .run()).rejects.toThrow('requires trusted upload publication');
  await sql('UPDATE drive_upload_intents SET version = version + 1 WHERE id = ?', intent).run();
  await expect(publisher(fetch).publish(token, id, dest)).resolves.toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(await alreadyMapped(id)).toBeNull();
});

it.each(['wrong length', 'wrong ETag', 'bad length', 'precondition', 'revocation', 'expiry', 'membership', 'version', 'cleanup', 'late uncertainty'])(
  'rejects %s without mapping or losing the receipt', async (failure) => {
    await migrate();
    const id = failure.replaceAll(' ', '-'), dest = destination(id);
    const { token, intent, part } = await completed(id);
    const fetch = vi.fn(async () => {
      if (failure === 'wrong length') return head(8);
      if (failure === 'wrong ETag') return head(7, '"other"');
      if (failure === 'bad length') return head('7.0');
      if (failure === 'precondition') return new Response(null, { status: 412 });
      if (failure === 'revocation') await sessions.revoke(token);
      if (failure === 'expiry') await sql('UPDATE drive_sessions SET expires_at = 1 WHERE principal_id = ?', `owner-${id}`).run();
      if (failure === 'membership') await sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", `owner-${id}`).run();
      if (failure === 'version') await sql('UPDATE drive_upload_intents SET version = version + 1 WHERE id = ?', intent).run();
      if (failure === 'cleanup') await tombstone(intent);
      if (failure === 'late uncertainty') await sql("INSERT INTO drive_upload_part_observations VALUES (?, 'uncertain', NULL)", part).run();
      return head();
    });
    await expect(publisher(fetch).publish(token, id, dest)).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await alreadyMapped(id)).toBeNull();
    expect(await sql('SELECT id FROM drive_entries WHERE id = ?', dest.entryId).first()).toBeNull();
    expect(await evidence('receipts', id)).not.toBeNull();
  });

it.each([false, true])('cannot publish an uncertain dispatch with or without late evidence (late=%s)', async (late) => {
  await migrate();
  const id = `quarantine-${late}`, { token, key } = await seed(id);
  const completion = producer(async () => {
    await completion.quarantineUnresolved(id);
    if (late) return response(key);
    throw new Error('lost provider response');
  });
  await expect(completion.complete(token, id)).resolves.toBe(late ? 'recorded' : 'uncertain');
  const fetch = vi.fn();
  await expect(publisher(fetch).publish(token, id, destination(id))).resolves.toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  expect(await alreadyMapped(id)).toBeNull();
  expect(await evidence('receipts', id) !== null).toBe(late);
});

it('reconciles an exact winner between the initial map lookup and receipt lookup', async () => {
  await migrate();
  const id = 'exact-race', dest = destination(id), { token } = await completed(id);
  const winner = publisher(async () => head()), fetch = vi.fn();
  const db = { prepare: (query) => env.DB.prepare(query), withSession: (mode) => ({ prepare: (query) => ({
    bind: (...args) => ({ async first() {
      if (query.includes('AS key_hex')) await expect(winner.publish(token, id, dest)).resolves.toBe(true);
      return env.DB.withSession(mode).prepare(query).bind(...args).first();
    } }),
  }) }) };
  await expect(publisher(fetch, db).publish(token, id, dest)).resolves.toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it('serializes competing uploads for one destination and preserves the losing receipt', async () => {
  await migrate();
  const ids = ['first-race', 'second-race'];
  const uploads = await Promise.all(ids.map((id) => completed(id, { owner: 'racing-owner' })));
  const publish = publisher(async () => head());
  const results = await Promise.all(ids.map((id, i) => publish.publish(uploads[i].token, id,
    { ...destination(id), name: 'contended.bin' })));
  expect(results.filter(Boolean)).toHaveLength(1);
  for (const [i, id] of ids.entries()) {
    expect(await alreadyMapped(id) !== null).toBe(results[i]);
    expect(await sql('SELECT id FROM drive_entries WHERE id = ?', destination(id).entryId).first() !== null).toBe(results[i]);
    expect(await evidence('receipts', id)).not.toBeNull();
  }
  const loser = results.indexOf(false);
  expect(await intentRow(uploads[loser].intent)).toMatchObject({ state: 'completing', version: 3 });
  await expect(publish.publish(uploads[loser].token, ids[loser], destination(ids[loser]))).resolves.toBe(true);
});
