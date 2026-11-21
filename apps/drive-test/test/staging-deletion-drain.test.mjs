import { afterEach, expect, it, vi } from 'vitest';
import { tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';
import { PrivateDeletion } from '../../drive/src/lib/server/metadata/private-deletion.ts';
import { deletionDrainCron, dispatchStagingDeletion, runStagingDeletionDrain } from '../../drive/src/lib/server/staging-deletion.ts';
import { bindings, job, qualification, removal, sentRequest, snapshot } from './fixtures/staging-deletion.mjs';
import { config, epoch, sql } from './fixtures/upload-completion.mjs';
import { etag, seedBoundPublication } from './fixtures/upload-publication-generation.mjs';

const event = { cron: deletionDrainCron };
const enabled = { ...bindings, DRIVE_STAGING_DELETE_DRAIN: '1' };
const tick = () => runStagingDeletionDrain(event, enabled, qualification);
const due = (id) => sql('UPDATE drive_object_deletion_jobs SET available_at = unixepoch() - 1 WHERE entry_id = ?', id).run();
afterEach(() => vi.unstubAllGlobals());

async function enqueue(label) {
  const file = await seedBoundPublication(label);
  expect(await new PrivateDeletion(bindings.DB).delete(file.token, file.id)).toBe(true);
  return file;
}

it('does not lease or dispatch with a disabled or mismatched scheduled admission', async () => {
  const file = await enqueue('closed-drain');
  const before = await snapshot();
  const fetch = vi.fn(async () => removal());
  vi.stubGlobal('fetch', fetch);
  for (const [env, rule, trigger = event] of [
    [bindings, qualification], [{ ...bindings, DRIVE_STAGING_DELETE_REQUESTS: '1' }, qualification],
    [enabled, undefined], [{ ...enabled, DRIVE_ORIGIN: 'disabled' }, qualification],
    [{ ...enabled, DRIVE_SIGN_IN_FIXTURE: '1' }, qualification],
    [{ ...enabled, DRIVE_QUALIFICATION_EXPIRES_AT: '1' }, qualification],
    [{ ...enabled, DRIVE_S3_BUCKET: 'different-bucket' }, qualification],
    [{ ...enabled, DRIVE_S3_REGION: 'different-region' }, qualification],
    [enabled, { ...qualification, confirmsRemoval: undefined }],
    [enabled, qualification, { cron: '* * * * *' }],
  ]) {
    expect(await runStagingDeletionDrain(trigger, env, rule)).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  }
  // Matching new bindings still cannot resolve a job's historical namespace.
  const newEpoch = 'rotated-epoch';
  expect(await runStagingDeletionDrain(event, { ...enabled, DRIVE_S3_STORAGE_EPOCH: newEpoch }, {
    ...qualification, storageConfigId: JSON.stringify([config.endpoint, config.bucket, newEpoch])
  })).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(await job(file.id)).toMatchObject({ completed_at: null, completion_token: null, lease_token: null });
});

// Seed additional real publication rows for one owner and one deletion journal.
async function addChild(hash, owner, folder, key) {
  const id = crypto.randomUUID(), revision = crypto.randomUUID();
  const intent = `intent-${key}`, part = `part-${key}`, op = `operation-${key}`;
  await bindings.DB.batch([
    sql("INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size) VALUES (?, ?, ?, 'created', 7)", intent, owner, key),
    sql('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)', intent, config.endpoint, config.bucket, epoch),
    sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = 'fixture-upload', version = 2 WHERE id = ?", intent),
    sql("INSERT INTO drive_upload_completion_operations VALUES (?, ?, ?, ?, ?, 'fixture-upload', 2)", op, intent, owner, key, epoch),
    sql("INSERT INTO drive_upload_part_operations VALUES (?, ?, ?, ?, ?, 'fixture-upload', 2, 1, 7)", part, intent, owner, key, epoch),
    sql("INSERT INTO drive_upload_part_observations VALUES (?, 'reported', X'227022')", part),
    sql("INSERT INTO drive_upload_sealed_snapshots VALUES (?, '[1]', 7)", op),
    sql('INSERT INTO drive_upload_completion_dispatches VALUES (?, ?, ?, 3, ?, ?)', op, config.endpoint, config.bucket, 'a'.repeat(64), hash),
    sql("INSERT INTO drive_upload_completion_receipts VALUES (?, ?, ?, '{}')", op, revision, etag),
    sql('INSERT INTO drive_upload_publications VALUES (?, 3, ?, ?, ?, ?, ?, 7, ?, ?, ?)', intent, id, owner, key, folder, key, etag, op, revision),
  ]);
  return { id, key };
}

it('resumes overflow from the committed request after restart without treating absence as removal', async () => {
  const first = await seedBoundPublication('restart');
  const owner = await sql('SELECT owner_id FROM drive_entries WHERE id = ?', first.id).first('owner_id');
  const folder = crypto.randomUUID(), hash = await tokenHash(first.token);
  await sql("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, 'folder', 'folder')", folder, owner).run();
  await sql('UPDATE drive_entries SET parent_id = ? WHERE id = ?', folder, first.id).run();
  const files = [first];
  for (let i = 0; i < 8; i++) files.push(await addChild(hash, owner, folder, `restart-${i}.bin`));

  let lostUrl;
  const requestFetch = vi.fn(async (req) => {
    if (lostUrl) return removal();
    lostUrl = req.url;
    // The provider may have removed the object before the response was lost.
    throw new Error('lost provider reply');
  });
  vi.stubGlobal('fetch', requestFetch);
  const body = '{"confirm":"permanent-delete"}';
  const response = await dispatchStagingDeletion(new Request(`${bindings.DRIVE_ORIGIN}/api/entries/${folder}/delete`, {
    method: 'POST', body, headers: { origin: bindings.DRIVE_ORIGIN, cookie: `__Host-drive-session=${first.token}`,
      'content-type': 'application/json', 'content-length': String(body.length) }
  }), { ...bindings, DRIVE_STAGING_DELETE_REQUESTS: '1', DRIVE_STAGING_INVITE_ACCEPTANCE: '1' }, qualification);
  expect(response.status).toBe(202);
  expect(requestFetch).toHaveBeenCalledTimes(8);
  const url = ({ key }) => `${config.endpoint}/${config.bucket}/${key}`;
  const attempted = requestFetch.mock.calls.map(([req]) => req.url);
  const overflow = files.find(file => !attempted.includes(url(file)));
  const lost = files.find(file => url(file) === lostUrl);
  expect(overflow).toBeDefined();
  expect(lost).toBeDefined();
  expect(await job(overflow.id)).toMatchObject({ completed_at: null, lease_token: null });
  expect(await job(lost.id)).toMatchObject({ completed_at: null, completion_token: null, lease_token: null });
  expect(await sql('SELECT count(*) AS n FROM drive_entries WHERE owner_id = ?', owner).first('n')).toBe(0);
  const jobs = await Promise.all(files.map(file => job(file.id)));
  expect(jobs.filter(row => row.completion_token !== null)).toHaveLength(7);

  // New invocation: no request, session, resolver state or knowledge of the journal ID.
  const scheduledFetch = vi.fn(async (req) => removal(req.url !== lostUrl));
  vi.stubGlobal('fetch', scheduledFetch);
  expect(await tick()).toBe(1);
  expect(await tick()).toBe(0);
  await due(lost.id);
  expect(await tick()).toBe(0);
  expect(scheduledFetch.mock.calls.map(([req]) => sentRequest(req))).toEqual([
    ['DELETE', url(overflow), true], ['DELETE', url(lost), true]
  ]);
  expect((await job(overflow.id)).completion_token).not.toBeNull();
  expect(await job(lost.id)).toMatchObject({ completed_at: null, completion_token: null, lease_token: null });
});

it('does not settle a stale lease from a late positive provider reply', async () => {
  const file = await enqueue('stale-drain');
  const replacement = crypto.randomUUID();
  const fetch = vi.fn(async () => {
    await sql('UPDATE drive_object_deletion_jobs SET lease_token = ?, available_at = unixepoch() + 60 WHERE entry_id = ?',
      replacement, file.id).run();
    return removal();
  });
  vi.stubGlobal('fetch', fetch);
  expect(await tick()).toBe(0);
  expect(fetch.mock.settledResults).toEqual([{ type: 'fulfilled', value: expect.any(Response) }]);
  expect(await job(file.id)).toMatchObject({ completed_at: null, completion_token: null, lease_token: replacement });
  // A later tick may reclaim it, but an ambiguous reply must not settle it either.
  await due(file.id);
  vi.stubGlobal('fetch', vi.fn(async () => removal(false)));
  expect(await tick()).toBe(0);
  expect(await job(file.id)).toMatchObject({ completed_at: null, completion_token: null, lease_token: null });
});

it('attempts only eight due jobs per scheduled event', async () => {
  const files = [];
  for (let i = 0; i < 9; i++) files.push(await enqueue(`scheduled-cap-${i}`));
  const fetch = vi.fn(async () => removal());
  vi.stubGlobal('fetch', fetch);
  expect(await tick()).toBe(8);
  expect(fetch).toHaveBeenCalledTimes(8);
  expect(await tick()).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(9);
  for (const file of files) expect((await job(file.id)).completion_token).not.toBeNull();
});
