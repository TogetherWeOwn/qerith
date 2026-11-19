import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const endpoint = 'https://storage.example.test', bucket = 'drive-test', epoch = 'smoke', etag = '"fixed-generation"';
const owner = 'owner-fixture';
const confirmation = '{"confirm":"permanent-delete"}';

// Imported only by the temporary smoke wrapper, not the generated Worker.
export const deletionWorker = `
import { privateDeletionFixtures } from ${JSON.stringify(resolve('src/lib/server/private-deletion-route.ts'))};
function admitDeletion(request, DB) {
  if (request.headers.get('x-test-deletion') !== '1') return;
  privateDeletionFixtures.set(request, {
    config: { endpoint: '${endpoint}', bucket: '${bucket}', region: 'auto', accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    epoch: '${epoch}',
    provider: {
      async fetch(input) {
        const key = new URL(input.url).pathname;
        await DB.prepare('INSERT INTO smoke_deletion_calls VALUES (?, ?, ?)').bind(key, input.method, input.headers.get('if-match')).run();
        return new Response(null, { status: 204, headers: key.endsWith('/ambiguous') ? {} : { 'x-fixture-removal': 'permanent' } });
      },
      confirmsRemoval: ({ headers }) => headers.get('x-fixture-removal') === 'permanent',
    }
  });
}`;

export async function exerciseDeletion({ worker, DB, origin, cookie, revoked, other, preview = false }) {
  const sql = (query, ...args) => DB.prepare(query).bind(...args);
  await DB.prepare('CREATE TABLE smoke_deletion_calls (key TEXT, method TEXT, etag TEXT)').run();
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
    const actual = new Headers({ cookie, origin, 'content-type': 'application/json', 'x-test-deletion': '1' });
    for (const [name, value] of Object.entries(headers)) value === null ? actual.delete(name) : actual.set(name, value);
    const result = await worker.fetch(`${origin}/api/entries/${id}/delete`, { method: 'POST', headers: actual, body, redirect: 'manual' });
    assert.deepEqual([result.status, result.headers.get('cache-control'), await result.text()], [status, 'private, no-store', '']);
  }
  const count = (table) => DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n');
  const snapshot = () => Promise.all(['drive_entries', 'drive_deleted_entries', 'drive_object_deletion_jobs',
    'drive_upload_publication_tombstones', 'smoke_deletion_calls'].map(count));
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
    [{ 'x-test-deletion': null }, 404], [{ cookie: null }, 401], [{ cookie: revoked }, 401], [{ cookie: other }, 404],
    [{ origin: null }, 403], [{ origin: 'https://other.example.test' }, 403],
    [{}, 400, '{}'], [{}, 400, '{"confirm":"permanent-DELETE"}'],
    [{}, 400, '{"confirm":"permanent-delete","extra":true}'], [{}, 400, ' '.repeat(129)],
  ]) await remove(selected.root, status, headers, body);
  await remove('not-an-opaque-id', 400);
  const wrongMethod = await worker.fetch(`${origin}/api/entries/${selected.root}/delete`, { headers: { cookie } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.deepEqual(await snapshot(), before);

  for (const [limit, chain] of [[128, false], [33, true]]) {
    const ids = Array.from({ length: limit + 1 }, () => randomUUID());
    for (let offset = 0; offset < ids.length; offset += 32) {
      await DB.batch(ids.slice(offset, offset + 32).map((id, i) => {
        const index = offset + i;
        return folder(id, index === 0 ? null : ids[chain ? index - 1 : 0]);
      }));
    }
    const overLimit = await snapshot();
    await remove(ids[0], 404);
    assert.deepEqual(await snapshot(), overLimit);
  }
  const unrelated = await tree('unrelated');
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
  await remove(selected.root, 202);
  await checkCapture(selected);
  assert.ok((await job(selected.file))?.completed_at);
  const ambiguous = await tree('ambiguous');
  await remove(ambiguous.root, 202);
  await checkCapture(ambiguous);
  assert.deepEqual(await job(ambiguous.file), { completed_at: null, completion_token: null, lease_token: null });
  assert.deepEqual(await unrelatedJob(), untouched);
  const { results: calls } = await DB.prepare('SELECT * FROM smoke_deletion_calls ORDER BY key').all();
  assert.deepEqual(calls, ['ambiguous', 'selected'].map((key) => ({ key: `/${bucket}/${key}`, method: 'DELETE', etag })));

  const rollback = await tree('rollback');
  await sql('DELETE FROM drive_owner_usage WHERE owner_id = ?', owner).run();
  const preRollback = await snapshot();
  await remove(rollback.root, 503);
  assert.deepEqual(await snapshot(), preRollback);
  console.log('Generated deletion: closed owner admission, denied requests, tree bounds, scoped conditional removal, ambiguity and rollback passed');
}
