import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const path = '/fixture/upload-expected-parts';
const endpoint = 'https://storage.example.test', bucket = 'fixture', epoch = 'expected-parts-fixture';
export const expectedPartsWorker = `
import { UploadIntents } from ${JSON.stringify(resolve('src/lib/server/metadata/upload-intents.ts'))};
import { tokenHash } from ${JSON.stringify(resolve('src/lib/server/identity/sessions.ts'))};
import { readSessionToken } from ${JSON.stringify(resolve('src/lib/server/request-auth.ts'))};
function expectedPartsRequest(request, { DB }) {
  if (new URL(request.url).pathname !== ${JSON.stringify(path)} || request.method !== 'POST') return null;
  return bindExpectedParts(request, DB);
}
async function bindExpectedParts(request, DB) {
  const { principalId, size, parts, storageEpoch, legacy, mode } = await request.json();
  const token = readSessionToken(request);
  const hash = token === null ? '' : await tokenHash(token);
  const intents = new UploadIntents(DB);
  try {
    const args = [principalId, hash, size, ${JSON.stringify(endpoint)}, ${JSON.stringify(bucket)}, storageEpoch];
    const claim = legacy ? await intents.claimNewAllocation(...args, true)
      : await intents.claimNewExpectedAllocation(...args, mode, parts);
    return claim ? Response.json({ id: claim.id }, { status: 201 }) : new Response(null, { status: 401 });
  } catch (error) {
    if (error instanceof TypeError) return new Response(null, { status: 400 });
    if (storageEpoch === '') return new Response(null, { status: 500 });
    throw error;
  }
}`;

export async function exerciseExpectedParts({ worker, DB, origin, session, owner }) {
  const principalId = 'owner-fixture', memberId = 'expected-parts-member';
  const member = await session(memberId, 'member');
  const full = 16 * 1024 ** 2, size = full + 3;
  const a = 'a1'.repeat(32), b = 'b2'.repeat(32);
  const parts = [{ partNumber: 1, sizeBytes: full, sha256: a }, { partNumber: 2, sizeBytes: 3, sha256: b }];
  const ask = (data = {}, cookie = owner) => worker.fetch(`${origin}${path}`, {
    method: 'POST', headers: { cookie },
    body: JSON.stringify({ principalId, size, parts, storageEpoch: epoch, mode: 'owner', ...data }),
  });
  const issue = async (data, cookie) => {
    const response = await ask(data, cookie);
    assert.equal(response.status, 201);
    const { id } = await response.json();
    assert.match(id, /^[0-9a-f-]{36}$/);
    return id;
  };
  const query = (sql, ...values) => DB.prepare(sql).bind(...values);
  const ledgers = ['upload_intents', 'upload_intent_reservations', 'upload_key_reservations', 'upload_storage_bindings',
    'upload_part_operations', 'upload_part_observations', 'upload_part_byte_evidence'];
  const counts = () => Promise.all(ledgers.map(name => DB.prepare(`SELECT count(*) AS n FROM drive_${name}`).first('n')));
  const expected = (id) => query('SELECT expected_part_sha256s FROM drive_upload_intents WHERE id = ?', id)
    .first('expected_part_sha256s');

  const before = await counts();
  const id = await issue();
  assert.deepEqual(await counts(), before.map((n, i) => n + Number(i < 4)), 'binding is not acknowledged evidence');
  assert.deepEqual(await query(`SELECT i.declared_size, i.state, i.version, i.upload_id, i.completion_acknowledged,
    i.expected_part_sha256s, b.endpoint, b.bucket, b.storage_epoch FROM drive_upload_intents i
    JOIN drive_upload_storage_bindings b ON b.intent_id = i.id
    JOIN drive_upload_intent_reservations r ON r.intent_id = i.id AND r.owner_id = i.owner_id AND r.object_key = i.object_key
    WHERE i.id = ? AND i.owner_id = ?`, id, principalId).first(), {
    declared_size: size, state: 'initiating', version: 1, upload_id: null, completion_acknowledged: 0,
    expected_part_sha256s: a + b, endpoint, bucket, storage_epoch: epoch,
  });

  const second = await issue({ parts: parts.map((part, i) => ({ ...part, sha256: i ? a : b })) });
  assert.notEqual(second, id);
  assert.equal(await expected(second), b + a);
  const legacy = await issue({ legacy: true });
  assert.equal(await expected(legacy), null);
  for (const [target, digest] of [[id, b + a], [id, null], [legacy, a + b]]) {
    await assert.rejects(query(`UPDATE drive_upload_intents SET expected_part_sha256s = ? WHERE id = ?`, digest, target).run(), /immutable/);
  }
  await assert.rejects(query('UPDATE drive_upload_intents SET declared_size = ? WHERE id = ?', size + 1, id).run(), /immutable/);
  await assert.rejects(query(`INSERT OR REPLACE INTO drive_upload_intents (id, owner_id, object_key, state, declared_size, expected_part_sha256s)
    VALUES (?, ?, ?, 'created', ?, ?)`, id, principalId, randomUUID(), size, b + a).run());
  assert.equal(await expected(id), a + b);
  assert.equal(await expected(legacy), null);

  const ceiling = 5 * 1024 ** 3;
  const max = await issue({ size: ceiling, parts: Array.from({ length: 320 }, (_, i) => ({ ...parts[0], partNumber: i + 1 })) });
  assert.equal(await expected(max), a.repeat(320));
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  assert.equal(await expected(await issue({ size: 0, parts: [{ partNumber: 1, sizeBytes: 0, sha256: emptyHash }] })), emptyHash);

  const memberIntent = await issue({ principalId: memberId, mode: 'active' }, member);
  assert.equal(await query('SELECT owner_id FROM drive_upload_intents WHERE id = ?', memberIntent).first('owner_id'), memberId);

  const stable = await counts();
  for (const data of [
    { mode: 'invalid' }, { parts: null }, { parts: [] }, { parts: [parts[0]] }, { parts: [parts[1], parts[0]] }, { parts: [parts[0], parts[0]] },
    { parts: [parts[0], { ...parts[1], sizeBytes: 4 }] }, { parts: [{ ...parts[0], sizeBytes: full - 1 }, parts[1]] },
    { parts: [parts[0], { ...parts[1], sha256: b.toUpperCase() }] }, { parts: [parts[0], { ...parts[1], sha256: `${b}\n` }] },
    { size: ceiling + 1 }, { size: -1 }, { size: size + 0.5 },
  ]) assert.equal((await ask(data)).status, 400);
  for (const [declared, packed] of [[null, a], [size, a], [size, a + b.toUpperCase()], [size, `${a + b}\0x`]]) {
    await assert.rejects(query(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size, expected_part_sha256s)
      VALUES (?, ?, ?, 'created', ?, ?)`, randomUUID(), principalId, randomUUID(), declared, packed).run(), /CHECK constraint/);
  }
  assert.equal((await ask({}, '')).status, 401);
  assert.equal((await ask({}, member)).status, 401, 'another principal cannot bind an intent for the owner');
  assert.equal((await ask({ principalId: memberId }, member)).status, 401, 'owner-only mode requires the live owner role');
  assert.equal((await ask({ storageEpoch: '' })).status, 500, 'invalid storage binding aborts the whole D1 batch');
  await query('UPDATE drive_sessions SET expires_at = 0 WHERE principal_id = ?', principalId).run();
  assert.equal((await ask()).status, 401);
  assert.deepEqual(await counts(), stable, 'denials and batch rollback leave no partial binding or reservation');
  console.log('Disposable Worker: expected multipart part binding is atomic, immutable and owner-fenced');
}
