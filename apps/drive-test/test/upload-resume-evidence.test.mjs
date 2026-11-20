import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, expect, it, vi } from 'vitest';
import { tokenHash } from '../../drive/src/lib/server/identity/sessions.ts';
import { readUploadResumeEvidence } from '../../drive/src/lib/server/metadata/upload-resume-evidence.ts';
import { config, epoch, migrations, sessions, sql } from './fixtures/upload-completion.mjs';

const storage = { endpoint: config.endpoint, bucket: config.bucket, storageEpoch: epoch };
const partBytes = 16 * 1024 * 1024;
// Pin both sides of the same ceiling as root-upload and upload-intent tests.
const multipartLimit = 5 * 1024 ** 3;
const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const empty = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const full = '080acf35a507ac9849cfcba47dc2ad83e01b75663a516279c8b9d243b719643e'; // 16 MiB of zeros
const tag = new Uint8Array([34, 97, 34]).buffer;

beforeAll(() => applyD1Migrations(env.DB, migrations));

async function setup(declaredSize, bound = true) {
  const id = crypto.randomUUID(), principalId = `member-${id}`, key = `key-${id}`, uploadId = `upload-${id}`;
  await sql("INSERT INTO drive_principals (id, role, status) VALUES (?, 'member', 'active')", principalId).run();
  const { token } = await sessions.issue(principalId);
  const { generation } = await sql('SELECT generation FROM drive_login_generations WHERE principal_id = ?', principalId).first();
  await sql("INSERT INTO drive_upload_intents (id, owner_id, object_key, state, declared_size) VALUES (?, ?, ?, 'created', ?)",
    id, principalId, key, declaredSize).run();
  if (bound) await sql('INSERT INTO drive_upload_storage_bindings VALUES (?, ?, ?, ?)', id, storage.endpoint, storage.bucket, epoch).run();
  await sql("UPDATE drive_upload_intents SET state = 'allocated', upload_id = ?, version = 2 WHERE id = ?", uploadId, id).run();
  return { id, scope: { token, principalId, generation }, identity: [id, principalId, key, epoch, uploadId] };
}

const read = ({ id, scope }, binding = storage) => readUploadResumeEvidence(env.DB, id, scope, binding);
async function part(intent, number, size, digest) {
  const op = `part-${intent.id}-${number}`;
  await sql('INSERT INTO drive_upload_part_operations VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?)', op, ...intent.identity, number, size).run();
  if (digest) await sql('INSERT INTO drive_upload_part_byte_evidence VALUES (?, ?, ?)', op, Uint8Array.fromHex(digest).buffer, tag).run();
  return op;
}

it('uses one primary statement and returns an empty prefix only for an unused allocation', async () => {
  const intent = await setup(multipartLimit);
  const prepare = vi.fn((query) => env.DB.withSession('first-primary').prepare(query));
  const withSession = vi.fn(() => ({ prepare }));
  expect(await readUploadResumeEvidence({ withSession }, intent.id, intent.scope, storage)).toEqual({
    declaredSize: multipartLimit, parts: [],
  });
  expect(withSession).toHaveBeenCalledExactlyOnceWith('first-primary');
  expect(prepare).toHaveBeenCalledTimes(1);
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

it('distinguishes a zero-byte declaration from its acknowledged empty part', async () => {
  const intent = await setup(0);
  expect(await read(intent)).toEqual({ declaredSize: 0, parts: [] });
  await part(intent, 1, 0, empty);
  expect(await read(intent)).toEqual({ declaredSize: 0, parts: [{ partNumber: 1, sizeBytes: 0, sha256: empty }] });
});

it('rechecks ownership, storage and principal generation even for acknowledged bytes', async () => {
  const intent = await setup(3), other = await setup(3);
  await part(intent, 1, 3, abc);
  expect(await read({ ...intent, id: other.id })).toBeNull();
  expect(await read({ ...intent, scope: { ...intent.scope, token: other.scope.token } })).toBeNull();
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
  const intent = await setup(partBytes + 3);
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

it.each(['seal', 'cleanup', 'tombstone', 'version advanced'])('rejects bytes after %s', async (state) => {
  const intent = await setup(3);
  await part(intent, 1, 3, abc);
  expect(await read(intent)).not.toBeNull();
  if (state === 'seal') {
    await sql('INSERT INTO drive_upload_completion_operations VALUES (?, ?, ?, ?, ?, ?, 2)', `seal-${intent.id}`, ...intent.identity).run();
    await sql("INSERT INTO drive_upload_sealed_snapshots VALUES (?, '[1]', 3)", `seal-${intent.id}`).run();
  } else if (state === 'cleanup') await sql('INSERT INTO drive_upload_cleanup_claims VALUES (?)', intent.id).run();
  else if (state === 'tombstone') await sql('INSERT INTO drive_upload_publication_tombstones VALUES (?)', intent.id).run();
  else await sql('UPDATE drive_upload_intents SET version = version + 1 WHERE id = ?', intent.id).run();
  expect(await read(intent)).toBeNull();
});
