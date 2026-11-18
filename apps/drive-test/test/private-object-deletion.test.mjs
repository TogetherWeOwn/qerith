import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { PrivateDeletion } from '../../drive/src/lib/server/metadata/private-deletion.ts';
import { reconcilePrivateObjectDeletions } from '../../drive/src/lib/server/metadata/private-object-deletion.ts';
import { PrivateMetadata } from '../../drive/src/lib/server/metadata/private.ts';
import { ReadGrants } from '../../drive/src/lib/server/metadata/read-grants.ts';
import { etag, seedBoundPublication } from './fixtures/upload-publication-generation.mjs';
import { config, epoch, evidence, migrations, producer, seed, sessions, sql } from './fixtures/upload-completion.mjs';

const configId = JSON.stringify([config.endpoint, config.bucket, epoch]);
const job = (id) => sql('SELECT * FROM drive_object_deletion_jobs WHERE entry_id = ?', id).first();
const makeDue = (id) => sql('UPDATE drive_object_deletion_jobs SET available_at = unixepoch() - 1 WHERE entry_id = ?', id).run();
const remove = (token, id) => new PrivateDeletion(env.DB).delete(token, id);
const run = (deleteIfMatch) => reconcilePrivateObjectDeletions(env.DB, (id) =>
  id === configId ? { storageConfigId: configId, deleteIfMatch } : null);
const tombstone = (intent) => sql('SELECT intent_id FROM drive_upload_publication_tombstones WHERE intent_id = ?', intent).first();

// Start at the pre-queue schema before other cases apply the full set.
it('does not backfill earlier deletions or infer authority from a missing entry', async () => {
  const schema = migrations.filter(({ name }) => name < '0031_private_object_deletion_jobs.sql');
  const removed = await seedBoundPublication('before-migration', { schema });
  const missing = await seedBoundPublication('metadata-only', { schema });
  expect(await sql("SELECT name FROM sqlite_master WHERE name = 'drive_object_deletion_jobs'").first()).toBeNull();
  expect(await remove(removed.token, removed.id)).toBe(true);
  await applyD1Migrations(env.DB, migrations);
  await sql('DELETE FROM drive_entries WHERE id = ?', missing.id).run();
  const deleteIfMatch = vi.fn(async () => 'deleted');
  expect(await run(deleteIfMatch)).toBe(0);
  expect(deleteIfMatch).not.toHaveBeenCalled();
  for (const { id, intent } of [removed, missing]) {
    expect(await job(id)).toBeNull();
    expect(await tombstone(intent)).toBeNull();
    expect(await sql('SELECT entry_id FROM drive_published_generations WHERE entry_id = ?', id).first()).not.toBeNull();
  }
});

it('journals only authorized removal of a bound object, never revocation or an unresolved upload', async () => {
  const { id, token, key, intent, evidenceRevision } = await seedBoundPublication('authorized', { key: `${String.fromCodePoint(0xFEFF)}folder/é+%` });
  const unresolved = await seed('unresolved');
  expect(await producer(async () => { throw new Error('unknown completion'); }).complete(unresolved.token, 'unresolved')).toBe('uncertain');
  expect(await evidence('quarantine', 'unresolved')).not.toBeNull();
  await sql("INSERT INTO drive_principals VALUES ('delete-grantee', 'member', 'active')").run();
  const recipient = (await sessions.issue('delete-grantee')).token;
  const grants = new ReadGrants(env.DB);
  expect(await grants.create(token, id, 'delete-grantee')).toBe(true);
  expect(await remove(recipient, id)).toBe(false);
  expect(await grants.revoke(token, id, 'delete-grantee')).toBe(true);
  await sql(`INSERT INTO drive_entries VALUES ('legacy', 'owner-unresolved', NULL, 'legacy', 'file', ?, 7)`, unresolved.key).run();
  expect(await remove(unresolved.token, 'legacy')).toBe(true);
  expect(await job('legacy')).toBeNull();
  expect(await tombstone(unresolved.intent)).toBeNull();
  expect(await job(id)).toBeNull();
  expect(await tombstone(intent)).toBeNull();
  expect(await remove(token, id)).toBe(true);
  expect(await remove(token, id)).toBe(false);
  expect(await tombstone(intent)).not.toBeNull();
  expect(await reconcilePrivateObjectDeletions(env.DB)).toBe(0);
  const deleteIfMatch = vi.fn(async () => 'deleted');
  for (const [index, replacement] of ['https://other.example', 'other-bucket', 'replacement-epoch'].entries()) {
    const parts = [config.endpoint, config.bucket, epoch];
    parts[index] = replacement;
    const resolve = vi.fn(() => ({ storageConfigId: JSON.stringify(parts), deleteIfMatch }));
    expect(await reconcilePrivateObjectDeletions(env.DB, resolve)).toBe(0);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(configId);
    expect((await job(id)).completed_at).toBeNull();
    await makeDue(id);
  }
  expect(deleteIfMatch).not.toHaveBeenCalled();
  await sql('DELETE FROM drive_upload_intents WHERE id = ?', intent).run();
  expect(await run(deleteIfMatch)).toBe(1);
  expect(deleteIfMatch).toHaveBeenCalledExactlyOnceWith({ key, etag, sizeBytes: 7, evidenceRevision }, expect.any(AbortSignal));
  expect((await job(id)).completed_at).not.toBeNull();
  expect(await sql('SELECT object_key FROM drive_deleted_entries WHERE entry_id = ?', id).first()).toEqual({ object_key: key });
  expect(await sql('SELECT evidence_revision FROM drive_published_generations WHERE entry_id = ?', id).first()).toEqual({ evidence_revision: evidenceRevision });
  expect(await run(deleteIfMatch)).toBe(0);
  await expect(sql('UPDATE drive_object_deletion_jobs SET completed_at = NULL WHERE entry_id = ?', id).run()).rejects.toThrow(/immutable/);
  await expect(sql('DELETE FROM drive_object_deletion_jobs WHERE entry_id = ?', id).run()).rejects.toThrow(/permanent/);
});

it('rolls back the subtree deletion and both tombstones when the job cannot be written', async () => {
  const { id, token, intent } = await seedBoundPublication('tree');
  await sql("INSERT INTO drive_entries VALUES ('tree-root', 'owner-tree', NULL, 'root', 'folder', NULL, NULL)").run();
  await new PrivateMetadata(env.DB).move('owner-tree', id, 'tree-root', 'file');
  await sql(`CREATE TRIGGER test_enqueue_failure BEFORE INSERT ON drive_object_deletion_jobs
    BEGIN SELECT RAISE(ABORT, 'test enqueue failure'); END`).run();
  try {
    await expect(remove(token, 'tree-root')).rejects.toThrow(/test enqueue failure/);
    expect(await sql("SELECT id FROM drive_entries WHERE id = ? AND parent_id = 'tree-root'", id).first()).toEqual({ id });
    expect(await sql("SELECT entry_id FROM drive_deleted_entries WHERE entry_id IN (?, 'tree-root')", id).first()).toBeNull();
    expect(await tombstone(intent)).toBeNull();
    expect(await job(id)).toBeNull();
  } finally { await sql('DROP TRIGGER test_enqueue_failure').run(); }
  // A prior intent fence is not deletion authority and must not prevent it.
  await sql('INSERT INTO drive_upload_publication_tombstones VALUES (?)', intent).run();
  expect(await job(id)).toBeNull();
  expect(await remove(token, 'tree-root')).toBe(true);
  expect(await tombstone(intent)).not.toBeNull();
  expect(await job('tree-root')).toBeNull();
  expect(await run(async () => 'deleted')).toBe(1);
});

it('leaves the ninth due job for another pass', async () => {
  for (let i = 0; i < 9; i++) {
    const { id, token } = await seedBoundPublication(`batch-${i}`);
    expect(await remove(token, id)).toBe(true);
  }
  const deleteIfMatch = vi.fn(async () => 'deleted');
  expect(await run(deleteIfMatch)).toBe(8);
  expect(deleteIfMatch).toHaveBeenCalledTimes(8);
  expect(await run(deleteIfMatch)).toBe(1);
  expect(new Set(deleteIfMatch.mock.calls.map(([target]) => target.key)).size).toBe(9);
}, 20_000);

it.each(['late reply', 'ignores abort'])('times out without settlement when the provider %s', async (mode) => {
  const { id, token } = await seedBoundPublication(`timeout-${mode.replaceAll(' ', '-')}`);
  expect(await remove(token, id)).toBe(true);
  const provider = vi.fn((_target, signal) => new Promise(resolve => {
    if (mode === 'late reply') signal.addEventListener('abort', () => resolve('deleted'), { once: true });
  }));
  expect(await run(provider)).toBe(0);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(provider.mock.calls[0][1].aborted).toBe(true);
  expect((await job(id)).completed_at).toBeNull();
}, 20_000);

function interceptStatement(prefix, intercept) {
  return { withSession(mode) {
    const session = env.DB.withSession(mode);
    return { prepare(query) {
      if (!query.startsWith(prefix)) return session.prepare(query);
      return { bind: (...args) => ({ first: () => intercept(() => session.prepare(query).bind(...args).first()) }) };
    } };
  } };
}

it('does not dispatch if the generation read leaves too little time on the lease', async () => {
  const { id, token } = await seedBoundPublication('short-lease');
  expect(await remove(token, id)).toBe(true);
  const db = interceptStatement('SELECT g.endpoint', async first => ({ ...await first(), lease_remaining_ms: 1000 }));
  const deleteIfMatch = vi.fn(async () => 'deleted');
  expect(await reconcilePrivateObjectDeletions(db, () => ({ storageConfigId: configId, deleteIfMatch }))).toBe(0);
  expect(deleteIfMatch).not.toHaveBeenCalled();
  expect((await job(id)).completed_at).toBeNull();
});

it('refreshes the lease after resolving the provider and before dispatch', async () => {
  const { id, token } = await seedBoundPublication('dispatch-lease');
  expect(await remove(token, id)).toBe(true);
  const deleteIfMatch = vi.fn(async () => 'deleted');
  const steps = [];
  const db = interceptStatement('SELECT 1000 * (available_at', async first => {
    steps.push('lease');
    await sql("UPDATE drive_object_deletion_jobs SET lease_token = 'contender', available_at = unixepoch() + 60 WHERE entry_id = ?", id).run();
    return first();
  });
  expect(await reconcilePrivateObjectDeletions(db, () => {
    steps.push('resolve');
    return { storageConfigId: configId, deleteIfMatch };
  })).toBe(0);
  expect(steps).toEqual(['resolve', 'lease']);
  expect(deleteIfMatch).not.toHaveBeenCalled();
  expect((await job(id)).completed_at).toBeNull();
});

it.each(['before commit', 'after commit'])('recovers a receipt write error %s without repeating the provider delete', async (when) => {
  const { id, token } = await seedBoundPublication(`receipt-${when.replaceAll(' ', '-')}`);
  expect(await remove(token, id)).toBe(true);
  const write = vi.fn(async first => first()).mockImplementationOnce(async first => {
    if (when === 'after commit') await first();
    throw new Error('receipt write unacknowledged');
  });
  const db = interceptStatement('UPDATE drive_object_deletion_jobs\n      SET lease_token = NULL', write);
  const deleteIfMatch = vi.fn(async () => 'deleted');
  expect(await reconcilePrivateObjectDeletions(db, () => ({ storageConfigId: configId, deleteIfMatch }))).toBe(1);
  expect(deleteIfMatch).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(2);
  expect((await job(id)).completed_at).not.toBeNull();
});

it('retries only the same generation and never records ambiguous outcomes as completion', async () => {
  const { id, token } = await seedBoundPublication('retry');
  expect(await remove(token, id)).toBe(true);
  const uncertain = vi.fn().mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce('unconfirmed');
  expect(await run(uncertain)).toBe(0);
  expect((await job(id)).completed_at).toBeNull();
  expect(await run(uncertain)).toBe(0);
  expect(uncertain).toHaveBeenCalledTimes(1);
  await makeDue(id);
  expect(await run(uncertain)).toBe(0);
  expect((await job(id)).completed_at).toBeNull();
  expect(uncertain.mock.calls[0][0]).toEqual(uncertain.mock.calls[1][0]);
  await makeDue(id);
  expect(await run(async () => 'deleted')).toBe(1);
});

it('fences two workers and discards an acknowledged provider response after lease takeover', async () => {
  const { id, token } = await seedBoundPublication('lease');
  expect(await remove(token, id)).toBe(true);
  const started = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const stale = run((target) => { started.resolve(target); return reply.promise; });
  try {
    const target = await Promise.race([started.promise, stale.then(() => { throw new Error('provider not reached'); })]);
    const contender = vi.fn(async () => 'unconfirmed');
    expect(await run(contender)).toBe(0);
    expect(contender).not.toHaveBeenCalled();
    await makeDue(id);
    expect(await run(contender)).toBe(0);
    expect(contender).toHaveBeenCalledExactlyOnceWith(target, expect.any(AbortSignal));
  } finally { reply.resolve('deleted'); }
  expect(await stale).toBe(0);
  expect((await job(id)).completed_at).toBeNull();
  await makeDue(id);
  expect(await run(async () => 'deleted')).toBe(1);
});
