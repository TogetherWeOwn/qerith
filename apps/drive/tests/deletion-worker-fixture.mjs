import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { stagingOrigin } from '../src/lib/server/qualification-readiness.ts';

const endpoint = 'https://storage.example.test', bucket = 'drive-test', epoch = 'smoke', etag = '"fixed-generation"';
const owner = 'owner-fixture';
const confirmation = '{"confirm":"permanent-delete"}';

const deletionStorageBindings = {
  DRIVE_S3_ENDPOINT: `${endpoint.toUpperCase()}:443/`, DRIVE_S3_BUCKET: bucket, DRIVE_S3_REGION: 'auto',
  DRIVE_S3_ACCESS_KEY_ID: 'fixture', DRIVE_S3_SECRET_ACCESS_KEY: 'fixture', DRIVE_S3_STORAGE_EPOCH: epoch,
  DRIVE_S3_QUALIFICATION: JSON.stringify({ version: 1, storageConfigId: JSON.stringify([endpoint, bucket, epoch]),
    region: 'auto', sourceSha: 'a'.repeat(40), runId: '1', runAttempt: 1, completionTimeoutMs: 5000 })
};

// Only the disposable wrapper supplies a synthetic qualification and intercepts outbound fetch.
export const deletionWorker = `
import { env as deletionEnv } from 'cloudflare:workers';
import { deletePrivateEntry } from ${JSON.stringify(resolve('src/lib/server/private-deletion-route.ts'))};
globalThis.fetch = async (input) => {
  const { origin, pathname, search } = new URL(input.url);
  const etag = input.headers.get('if-match');
  const signed = input.headers.get('authorization')?.match(/SignedHeaders=([^,]+)/)?.[1].split(';');
  const valid = origin === '${endpoint}' && !search && input.method === 'DELETE' && !!etag && signed?.includes('if-match');
  // Persist validity so the test can assert it even if reconciliation catches the error.
  await deletionEnv.DB.prepare('INSERT INTO smoke_deletion_calls VALUES (?, ?, ?, ?)')
    .bind(pathname, input.method, etag, valid ? 1 : 0).run();
  if (!valid) throw new Error('Unexpected deletion dispatch');
  return new Response(null, { status: 204, headers: pathname.endsWith('/ambiguous') ? {} : { 'x-fixture-removal': 'permanent' } });
};
const capability = {
  sourceSha: 'a'.repeat(40), workerVersion: '00000000-0000-4000-8000-000000000002',
  expiresAt: String(Date.now() + 600_000),
  storageConfigId: JSON.stringify(['${endpoint}', '${bucket}', '${epoch}']), region: 'auto',
  confirmsRemoval: ({ headers }) => headers.get('x-fixture-removal') === 'permanent'
};
const qualifiedWorker = createDriveWorker(capability);
const expired = { ...capability, expiresAt: '1000000000000' };
const expiredWorker = createDriveWorker(expired);
function stagingDeletionBindings(env, mode) {
  return { ...env, ...${JSON.stringify(deletionStorageBindings)}, DRIVE_ORIGIN: ${JSON.stringify(stagingOrigin)},
    DRIVE_STAGING_DELETE_REQUESTS: mode === 'disabled' ? '0' : '1', DRIVE_STAGING_DELETE_DRAIN: '1',
    DRIVE_QUALIFICATION_SHA: mode === 'wrong-sha' ? 'b'.repeat(40) : capability.sourceSha,
    DRIVE_QUALIFICATION_VERSION: { id: mode === 'wrong-version' ? '00000000-0000-4000-8000-000000000003' : capability.workerVersion },
    DRIVE_QUALIFICATION_EXPIRES_AT: mode === 'expired' ? expired.expiresAt : capability.expiresAt,
    DRIVE_S3_STORAGE_EPOCH: mode === 'wrong-storage' ? 'wrong-epoch' : '${epoch}' };
}
function runtimeDeletion(request, env, ctx) {
  const entryId = /^\\/api\\/entries\\/([^/]+)\\/delete$/.exec(new URL(request.url).pathname)?.[1];
  if (!entryId) return;
  const staging = request.headers.get('x-test-staging-deletion');
  if (staging !== null) {
    const worker = staging === 'absent' ? app : staging === 'expired' ? expiredWorker : qualifiedWorker;
    return worker.fetch(request, stagingDeletionBindings(env, staging), ctx);
  }
  const bindings = { ...env, ...${JSON.stringify(deletionStorageBindings)} };
  const mode = request.headers.get('x-test-deletion');
  if (mode === null || request.headers.get('x-test-use-generated') === '1') return app.fetch(request, bindings, ctx);
  const epoch = mode === 'stale-epoch' ? 'new-epoch' : '${epoch}';
  return deletePrivateEntry(request, entryId, {
    ...bindings,
    DRIVE_S3_STORAGE_EPOCH: mode === 'missing-epoch' ? undefined : mode === 'mismatch' ? 'wrong-epoch' : epoch,
  }, {
    storageConfigId: JSON.stringify(['${endpoint}', '${bucket}', epoch]),
    region: 'auto',
    confirmsRemoval: mode === 'missing-rule' ? undefined : ({ headers }) => headers.get('x-fixture-removal') === 'permanent',
  });
}`;

export async function exerciseDeletion({ worker, DB, origin, cookie, revoked, other, preview = false }) {
  const sql = (query, ...args) => DB.prepare(query).bind(...args);
  await DB.prepare('CREATE TABLE smoke_deletion_calls (key TEXT, method TEXT, etag TEXT, valid INTEGER NOT NULL)').run();
  const hash = await sql('SELECT token_hash FROM drive_sessions WHERE principal_id = ?', owner).first('token_hash');
  const folder = (id, parent) => sql("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind) VALUES (?, ?, ?, ?, 'folder')", id, owner, parent, id);
  async function tree(key) {
    const root = randomUUID(), child = randomUUID(), file = randomUUID();
    const intent = `upload-${key}`, op = `complete-${key}`, part = `part-${key}`, revision = randomUUID();
    await DB.batch([
      folder(root, null), folder(child, root),
      sql("INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size) VALUES (?, ?, ?, 'created', 7)", intent, owner, key),
      sql('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)', intent, endpoint, bucket, epoch),
      sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = 'fixture-upload', version = 2 WHERE id = ?", intent),
      sql("INSERT INTO drive_upload_completion_operations VALUES (?, ?, ?, ?, ?, 'fixture-upload', 2)", op, intent, owner, key, epoch),
      sql("INSERT INTO drive_upload_part_operations VALUES (?, ?, ?, ?, ?, 'fixture-upload', 2, 1, 7)", part, intent, owner, key, epoch),
      sql("INSERT INTO drive_upload_part_observations VALUES (?, 'reported', X'227022')", part),
      sql("INSERT INTO drive_upload_sealed_snapshots VALUES (?, '[1]', 7)", op),
      sql('INSERT INTO drive_upload_completion_dispatches VALUES (?, ?, ?, 3, ?, ?)', op, endpoint, bucket, '0'.repeat(64), hash),
      sql("INSERT INTO drive_upload_completion_receipts VALUES (?, ?, ?, '{}')", op, revision, etag),
      sql('INSERT INTO drive_upload_publications VALUES (?, 3, ?, ?, ?, ?, ?, 7, ?, ?, ?)', intent, file, owner, key, child, key, etag, op, revision),
    ]);
    return { root, child, file };
  }
  async function remove(id, status, headers = {}, body = confirmation) {
    const target = headers['x-test-staging-deletion'] ? stagingOrigin : origin;
    const actual = new Headers({ cookie, origin: target, 'content-type': 'application/json', 'x-test-deletion': '1' });
    for (const [name, value] of Object.entries(headers)) value === null ? actual.delete(name) : actual.set(name, value);
    const result = await worker.fetch(`${target}/api/entries/${id}/delete`, { method: 'POST', headers: actual, body, redirect: 'manual' });
    if (headers['x-test-staging-deletion'] === 'expired') {
      assert.deepEqual([result.status, result.headers.get('cache-control')], [status, 'no-store']);
    } else {
      assert.deepEqual([result.status, result.headers.get('cache-control'), await result.text()], [status, 'private, no-store', '']);
    }
  }
  const snapshot = async () => (await DB.batch([
    DB.prepare('SELECT * FROM drive_entries ORDER BY id'),
    DB.prepare('SELECT * FROM drive_folder_counts ORDER BY folder_id'),
    DB.prepare('SELECT * FROM drive_owner_usage ORDER BY owner_id'),
    DB.prepare('SELECT * FROM drive_deleted_entries ORDER BY entry_id'),
    DB.prepare('SELECT * FROM drive_object_deletion_jobs ORDER BY entry_id'),
    DB.prepare('SELECT * FROM drive_upload_publication_tombstones ORDER BY intent_id'),
    DB.prepare('SELECT count(*) AS n FROM smoke_deletion_calls'),
  ])).map(({ results }) => results);
  const job = (file) => sql('SELECT completed_at, completion_token, lease_token FROM drive_object_deletion_jobs WHERE entry_id = ?', file).first();
  const selected = await tree('selected');
  const before = await snapshot();
  if (preview) {
    await remove(selected.root, 404);
    assert.deepEqual(await snapshot(), before);
    console.log('Generated deletion: authenticated preview owner cannot admit deletion');
    return;
  }
  for (const [headers, status, body] of [
    [{ 'x-test-deletion': null }, 404], [{ 'x-test-use-generated': '1' }, 404],
    [{ cookie: null }, 401], [{ cookie: revoked }, 401], [{ cookie: other }, 404],
    [{ 'x-test-deletion': 'missing-rule' }, 503], [{ 'x-test-deletion': 'missing-epoch' }, 503],
    [{ 'x-test-deletion': 'mismatch' }, 503], [{ 'x-test-deletion': 'stale-epoch' }, 404],
    [{ origin: null }, 403], [{ origin: 'https://other.example.test' }, 403],
    [{}, 400, '{}'], [{}, 400, '{"confirm":"permanent-DELETE"}'],
    [{}, 400, '{"confirm":"permanent-delete","extra":true}'], [{}, 400, ' '.repeat(129)],
  ]) {
    await remove(selected.root, status, headers, body);
    assert.deepEqual(await snapshot(), before, `Deletion refusal (${status}) changed state or dispatched`);
  }
  const staged = { 'x-test-staging-deletion': 'qualified' };
  for (const mode of ['absent', 'disabled', 'wrong-sha', 'wrong-version', 'wrong-storage', 'expired']) {
    await remove(selected.root, mode === 'expired' ? 503 : 404, { 'x-test-staging-deletion': mode });
    assert.deepEqual(await snapshot(), before, `Staging deletion refusal (${mode}) changed state or dispatched`);
  }
  await remove(selected.root, 403, { ...staged, origin: 'https://other.example.test' });
  await remove(selected.root, 401, { ...staged, cookie: revoked });
  await remove(selected.root, 400, staged, '{}');
  assert.deepEqual(await snapshot(), before);
  await remove('not-an-opaque-id', 400);
  const wrongMethod = await worker.fetch(`${origin}/api/entries/${selected.root}/delete`, { headers: { cookie } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.deepEqual(await snapshot(), before);

  // The selected child and its file contribute two more entries to each tree.
  for (const [folders, chain] of [[129 - 2, false], [34, true]]) {
    const ids = Array.from({ length: folders }, () => randomUUID());
    for (let offset = 0; offset < ids.length; offset += 32) {
      await DB.batch(ids.slice(offset, offset + 32).map((id, i) => {
        const index = offset + i;
        return folder(id, index === 0 ? null : ids[chain ? index - 1 : 0]);
      }));
    }
    const move = 'UPDATE drive_entries SET parent_id = ? WHERE id = ?';
    await sql(move, ids[0], selected.child).run();
    const overLimit = await snapshot();
    await remove(ids[0], 404);
    assert.deepEqual(await snapshot(), overLimit);
    await sql(move, selected.root, selected.child).run();
  }
  const unrelated = await tree('unrelated');
  await sql("INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes) VALUES (?, ?, ?, 'legacy', 'file', 'legacy-key', 7)",
    randomUUID(), owner, unrelated.child).run();
  const unpinned = await snapshot();
  await remove(unrelated.root, 404);
  assert.deepEqual(await snapshot(), unpinned);
  await DB.batch([
    sql('INSERT INTO drive_deleted_entries VALUES (?, ?, ?, ?)', unrelated.file, randomUUID(), owner, 'unrelated'),
    sql('DELETE FROM drive_entries WHERE id = ?', unrelated.file),
  ]);
  const unrelatedJob = () => sql('SELECT * FROM drive_object_deletion_jobs WHERE entry_id = ?', unrelated.file).first();
  const untouched = await unrelatedJob();
  assert.ok(untouched);
  const checkCapture = async ({ root, child, file }) => {
    const { results } = await sql('SELECT entry_id, deletion_id FROM drive_deleted_entries WHERE entry_id IN (?, ?, ?)', root, child, file).all();
    assert.equal(results.length, 3);
    assert.equal(new Set(results.map((row) => row.deletion_id)).size, 1);
    assert.equal(await sql('SELECT count(*) AS n FROM drive_entries WHERE id IN (?, ?, ?)', root, child, file).first('n'), 0);
  };
  await remove(selected.root, 202, staged);
  await checkCapture(selected);
  assert.ok((await job(selected.file))?.completed_at);
  const ambiguous = await tree('ambiguous');
  await remove(ambiguous.root, 202, staged);
  await checkCapture(ambiguous);
  assert.deepEqual(await job(ambiguous.file), { completed_at: null, completion_token: null, lease_token: null });
  assert.deepEqual(await unrelatedJob(), untouched);
  const preDrain = await snapshot();
  assert.equal((await worker.scheduled({ cron: '* * * * *' })).outcome, 'ok');
  assert.deepEqual(await snapshot(), preDrain);
  assert.equal((await worker.scheduled({ cron: '*/15 * * * *' })).outcome, 'ok');
  assert.ok((await job(unrelated.file))?.completed_at);
  const { results: calls } = await DB.prepare('SELECT * FROM smoke_deletion_calls ORDER BY key').all();
  assert.deepEqual(calls, ['ambiguous', 'selected', 'unrelated'].map((key) => ({ key: `/${bucket}/${key}`, method: 'DELETE', etag, valid: 1 })));

  const rollback = await tree('rollback');
  await sql('DELETE FROM drive_owner_usage WHERE owner_id = ?', owner).run();
  const preRollback = await snapshot();
  await remove(rollback.root, 503);
  assert.deepEqual(await snapshot(), preRollback);
  console.log('Generated deletion: closed owner admission, denied requests, tree bounds, scoped conditional removal, ambiguity and rollback passed');
}
