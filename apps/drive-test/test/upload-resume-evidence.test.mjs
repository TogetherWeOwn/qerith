import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, expect, it, vi } from 'vitest';
import { tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { readUploadResumeEvidence } from '../../drive/src/lib/server/metadata/upload-resume-evidence.ts';
import { stagingOrigin } from '../../drive/src/lib/server/request-auth.ts';
import { uploadRoutes } from '../../drive/src/lib/server/upload-routes.ts';
import { config, epoch, intentRow, migrations, sessions, sql } from './fixtures/upload-completion.mjs';

const storage = { endpoint: config.endpoint, bucket: config.bucket, storageEpoch: epoch };
const partBytes = 16 * 1024 * 1024;
// Pin both sides of the same ceiling as root-upload and upload-intent tests.
const multipartLimit = 5 * 1024 ** 3;
const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const full = '080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e'; // 16 MiB of zeros
const tag = new Uint8Array([34, 97, 34]).buffer;

beforeAll(() => applyD1Migrations(env.DB, migrations));

async function setup(declaredSize, storageBound = true, expectedPartSha256s = null) {
  const id = crypto.randomUUID(), principalId = `member-${id}`, key = `key-${id}`, uploadId = `upload-${id}`;
  await sql("INSERT INTO drive_principals (id, role, status) VALUES (?, 'member', 'active')", principalId).run();
  const { token } = await sessions.issue(principalId);
  const { generation } = await sql('SELECT generation FROM drive_login_generations WHERE principal_id = ?', principalId).first();
  await sql(`INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size, expected_part_sha256s)
    VALUES (?, ?, ?, 'created', ?, ?)`, id, principalId, key, declaredSize, expectedPartSha256s).run();
  if (storageBound) await sql('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)', id, storage.endpoint, storage.bucket, epoch).run();
  await sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = 2 WHERE id = ?", uploadId, id).run();
  return { id, scope: { token, principalId, generation, role: 'member' }, identity: [id, principalId, key, epoch, uploadId] };
}

const read = ({ id, scope }, binding = storage) => readUploadResumeEvidence(env.DB, id, scope, binding);
async function part(intent, number, size, digest) {
  const op = `part-${intent.id}-${number}`;
  await sql('INSERT INTO drive_upload_part_operations VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?)', op, ...intent.identity, number, size).run();
  if (digest) await sql('INSERT INTO drive_upload_part_byte_evidence VALUES (?, ?, ?)', op, Uint8Array.fromHex(digest).buffer, tag).run();
  return op;
}

it('returns the full bound plan but no acknowledgements for an unused allocation in one primary statement', async () => {
  const expectedPartSha256s = full.repeat(multipartLimit / partBytes);
  const intent = await setup(multipartLimit, true, expectedPartSha256s);
  const prepare = vi.fn((query) => env.DB.withSession('first-primary').prepare(query));
  const withSession = vi.fn(() => ({ prepare }));
  expect(await readUploadResumeEvidence({ withSession }, intent.id, intent.scope, storage)).toEqual({
    declaredSize: multipartLimit, parts: [], expectedPartSha256s,
  });
  expect(withSession).toHaveBeenCalledExactlyOnceWith('first-primary');
  expect(prepare).toHaveBeenCalledTimes(1);
});

it('returns unavailable rather than an empty prefix when the primary statement rejects', async () => {
  const intent = await setup(3);
  const all = vi.fn().mockRejectedValue(new Error('primary unavailable'));
  const db = { withSession: () => ({ prepare: () => ({ bind: () => ({ all }) }) }) };
  expect(await readUploadResumeEvidence(db, intent.id, intent.scope, storage)).toBeNull();
  expect(all).toHaveBeenCalledTimes(1);
});

it('returns the exact ordered prefix, including a short final part only when acknowledged', async () => {
  const intent = await setup(partBytes + 3);
  await part(intent, 1, partBytes, full);
  expect(await read(intent)).toEqual({ declaredSize: partBytes + 3, parts: [
    { partNumber: 1, sizeBytes: partBytes, sha256: full },
  ] });
  await part(intent, 2, 3, abc);
  expect(await read(intent)).toEqual({ declaredSize: partBytes + 3, parts: [
    { partNumber: 1, sizeBytes: partBytes, sha256: full }, { partNumber: 2, sizeBytes: 3, sha256: abc },
  ] });
});

it('distinguishes a zero-byte expectation from its acknowledged empty part', async () => {
  const intent = await setup(0, true, empty);
  expect(await read(intent)).toEqual({ declaredSize: 0, parts: [], expectedPartSha256s: empty });
  await part(intent, 1, 0, empty);
  expect(await read(intent)).toEqual({ declaredSize: 0, parts: [{ partNumber: 1, sizeBytes: 0, sha256: empty }],
    expectedPartSha256s: empty });
});

it('rejects a bound prefix when a receipt disagrees with its own slot', async () => {
  const declaredSize = partBytes + 3, expectedPartSha256s = full + abc;
  const intent = await setup(declaredSize, true, expectedPartSha256s);
  await part(intent, 1, partBytes, full);
  expect(await read(intent)).toEqual({ declaredSize, parts: [{ partNumber: 1, sizeBytes: partBytes, sha256: full }],
    expectedPartSha256s });
  await part(intent, 2, 3, full);
  expect(await read(intent)).toBeNull();
});

it.each([abc, full + abc.toUpperCase(), full + abc + '0'])('rejects a malformed projected plan', async (vector) => {
  const intent = await setup(partBytes + 3);
  const all = async () => ({ results: [{ declaredSize: partBytes + 3, partNumber: null, expectedPartSha256s: vector }] });
  const db = { withSession: () => ({ prepare: () => ({ bind: () => ({ all }) }) }) };
  expect(await readUploadResumeEvidence(db, intent.id, intent.scope, storage)).toBeNull();
});

it('serves only bound evidence through the staging handler and rechecks generation after qualification', async () => {
  const intent = await setup(3, true, abc);
  const { id, scope: { token, principalId } } = intent;
  const ask = (routes, bearer = token) => routes.stagingResume(new Request(`${stagingOrigin}/api/uploads/${id}/resume`, {
    headers: { cookie: `__Host-drive-session=${bearer}` },
  }), id);
  const fetch = vi.fn(() => { throw new Error('unexpected provider request'); });
  const verifyParts = vi.fn(fetch);
  const isQualified = vi.fn(async () => true);
  const bindings = { DB: env.DB, DRIVE_ORIGIN: stagingOrigin, DRIVE_STAGING_INVITE_ACCEPTANCE: '1',
    DRIVE_UPLOAD_S3: config, DRIVE_UPLOAD_EPOCH: epoch,
    DRIVE_UPLOAD_VERIFIER: { isQualified, verifyParts, completionTimeoutMs: () => 5000 } };
  const routes = uploadRoutes(bindings, { fetch, timeoutMs: 5000 });
  await part(intent, 1, 3, abc);
  const response = await ask(routes);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ declaredSize: 3, parts: [{ partNumber: 1, sizeBytes: 3, sha256: abc }],
    expectedPartSha256s: abc });
  expect(isQualified).toHaveBeenCalledWith(JSON.stringify([config.endpoint, config.bucket, epoch]));
  expect((await ask(routes, (await setup(3)).scope.token)).status).toBe(404);
  expect((await ask(uploadRoutes({ ...bindings, DRIVE_UPLOAD_EPOCH: 'other' }))).status).toBe(404);
  isQualified.mockImplementationOnce(async () => {
    await sql('UPDATE drive_login_generations SET generation = lower(hex(randomblob(32))) WHERE principal_id = ?', principalId).run();
    return true;
  });
  const denied = await ask(routes);
  expect([denied.status, denied.headers.get('cache-control'), await denied.text()]).toEqual([404, 'private, no-store', '']);
  expect(verifyParts).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('rechecks ownership, storage and principal generation even for acknowledged bytes', async () => {
  const intent = await setup(3), other = await setup(3);
  await part(intent, 1, 3, abc);
  expect(await read({ ...intent, id: other.id })).toBeNull();
  expect(await read({ ...intent, scope: { ...intent.scope, token: other.scope.token } })).toBeNull();
  expect(await read({ ...intent, scope: { ...intent.scope, role: 'owner' } })).toBeNull();
  for (const key of Object.keys(storage)) expect(await read(intent, { ...storage, [key]: 'different' })).toBeNull();
  await sql('UPDATE drive_login_generations SET generation = lower(hex(randomblob(32))) WHERE principal_id = ?', intent.scope.principalId).run();
  expect(await read(intent)).toBeNull();
});

it.each(['session revoked', 'expired', 'member revoked', 'member re-enabled'])('denies a session that is %s', async (state) => {
  const intent = await setup(3), { token, principalId } = intent.scope;
  await part(intent, 1, 3, abc);
  if (state === 'session revoked') await sessions.revoke(token);
  else if (state === 'expired') await sql('UPDATE drive_sessions SET expires_at = 1 WHERE token_hash = ?', await tokenHash(token)).run();
  else {
    await sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", principalId).run();
    if (state === 'member re-enabled') await sql("UPDATE drive_principals SET status = 'active' WHERE id = ?", principalId).run();
    // Even supplying the new generation cannot resurrect the revoked bearer.
    intent.scope.generation = (await sql('SELECT generation FROM drive_login_generations WHERE principal_id = ?', principalId).first()).generation;
  }
  expect(await read(intent)).toBeNull();
});

it.each(['in flight', 'legacy receipt', 'reported then uncertain'])('rejects a whole prefix with a later %s slot', async (state) => {
  const intent = await setup(partBytes + 3, true, full + abc);
  await part(intent, 1, partBytes, full);
  const op = await part(intent, 2, 3, state === 'reported then uncertain' ? abc : undefined);
  if (state === 'legacy receipt') await sql("INSERT INTO drive_upload_part_observations VALUES (?, 'reported', ?)", op, tag).run();
  if (state === 'reported then uncertain') await sql("INSERT INTO drive_upload_part_observations VALUES (?, 'uncertain', NULL)", op).run();
  expect(await read(intent)).toBeNull();
});

it.each([
  [partBytes + 3, 2, 3], // Gap, even with a valid final receipt.
  [partBytes + 3, 1, 3], // Nonfinal part is short.
  [3, 1, 0], // Final part does not match the declaration.
  [3, 1, 4], // Part extends beyond the declaration.
])('rejects a nonsequential layout (declared %s, part %s, bytes %s)', async (size, number, bytes) => {
  const intent = await setup(size);
  await part(intent, number, bytes, abc);
  expect(await read(intent)).toBeNull();
});

it.each([
  ['legacy declaration', null, true], ['oversized declaration', multipartLimit + 1, true], ['missing storage binding', 3, false],
])('rejects an allocation with %s even before any parts', async (_, size, bound) => {
  expect(await read(await setup(size, bound))).toBeNull();
});

const completion = (intent) => sql('INSERT INTO drive_upload_completion_operations VALUES (?, ?, ?, ?, ?, ?, 2)',
  `seal-${intent.id}`, ...intent.identity).run();
const cleanup = (id) => sql('INSERT INTO drive_upload_cleanup_claims VALUES (?)', id).run();
const tombstone = (id) => sql('INSERT INTO drive_upload_publication_tombstones VALUES (?)', id).run();

it.each(['seal', 'cleanup', 'tombstone', 'version advanced'])('rejects bytes after %s', async (state) => {
  const intent = await setup(3);
  await part(intent, 1, 3, abc);
  expect(await read(intent)).not.toBeNull();
  if (state === 'seal') {
    await completion(intent);
    await sql("INSERT INTO drive_upload_sealed_snapshots VALUES (?, '[1]', 3)", `seal-${intent.id}`).run();
  } else if (state === 'cleanup') await cleanup(intent.id);
  else if (state === 'tombstone') await tombstone(intent.id);
  else await sql('UPDATE drive_upload_intents SET version = version + 1 WHERE id = ?', intent.id).run();
  expect(await read(intent)).toBeNull();
});

it.each(['completion', 'cleanup', 'tombstone', 'publication attempt'])('rejects an unused allocation fenced by %s', async (fence) => {
  const intent = await setup(3), [id, owner, key, , uploadId] = intent.identity;
  expect(await read(intent)).toEqual({ declaredSize: 3, parts: [] });
  if (fence === 'completion') await completion(intent);
  else if (fence === 'cleanup') await cleanup(id);
  else if (fence === 'tombstone') await tombstone(id);
  else {
    await sql('INSERT INTO drive_upload_publication_attempts VALUES (?, ?, ?, 2, 3)', id, key, uploadId).run();
    // The retained attempt alone must fence the read once the journal is allocated again.
    expect(await new UploadIntents(env.DB).recordNotDispatched(owner, id, 3, 'completion')).toBe(true);
    expect(await intentRow(id)).toMatchObject({ state: 'allocated', version: 4 });
  }
  expect(await read(intent)).toBeNull();
});
