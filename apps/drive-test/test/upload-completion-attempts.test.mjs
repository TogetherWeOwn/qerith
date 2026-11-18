import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, expect, it, vi } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { evidence, intentRow, migrations, parts, producer, seed, sql } from './fixtures/upload-completion.mjs';

const intents = new UploadIntents(env.DB);
const sized = (id) => seed(id, { declaredSize: 7, intent: `intent-${id}` });
const attempt = (row, version = row.version) => sql('INSERT INTO drive_upload_publication_attempts VALUES (?, ?, ?, ?, ?)',
  row.id, row.object_key, row.upload_id, version, row.declared_size).run();
const storedAttempt = (id) => sql('SELECT * FROM drive_upload_publication_attempts WHERE intent_id = ?', id).first();
const cleanup = (id) => sql('INSERT INTO drive_upload_cleanup_claims VALUES (?)', id).run();
async function dispatch(id) {
  const row = await sql('SELECT * FROM drive_upload_sealed_candidates WHERE operation_id = ?', id).first();
  expect(row).not.toBeNull(); // The old dispatch guard would admit this row.
  return sql('INSERT INTO drive_upload_completion_dispatches VALUES (?, ?, ?, ?, ?, ?)',
    id, row.endpoint, row.bucket, row.intent_version + 1, 'a'.repeat(64), row.session_hash).run();
}

beforeEach(() => applyD1Migrations(env.DB, migrations));

it('keeps cleanup and legacy completion fenced after an attempt and journal reset', async () => {
  const { intent, token } = await sized('attempt-first'), owner = 'owner-attempt-first';
  const row = await intentRow(intent);
  expect(row).toMatchObject({ state: 'allocated', version: 2, declared_size: 7 });
  await expect(attempt(row, 1)).rejects.toThrow('upload completion claim is stale');
  expect(await storedAttempt(intent)).toBeNull();
  await attempt(row);
  expect(await storedAttempt(intent)).toMatchObject({ version: 2 });
  expect(await intentRow(intent)).toMatchObject({ state: 'completing', version: 3 });

  expect(await intents.recordNotDispatched(owner, intent, 3, 'completion')).toBe(true);
  expect(await intentRow(intent)).toMatchObject({ state: 'allocated', version: 4 });
  await expect(cleanup(intent)).rejects.toThrow('upload completion may be in flight');
  await expect(intents.claim(owner, intent, 4, 'completion')).resolves.toBeNull();
  await expect(sql('INSERT OR REPLACE INTO drive_upload_publication_attempts VALUES (?, ?, ?, ?, ?)',
    intent, row.object_key, row.upload_id, 4, row.declared_size).run()).rejects.toThrow('upload completion already attempted');
  await expect(sql('UPDATE drive_upload_publication_attempts SET version = 4 WHERE intent_id = ?', intent).run())
    .rejects.toThrow('upload completion attempts are immutable');
  await expect(sql('DELETE FROM drive_upload_publication_attempts WHERE intent_id = ?', intent).run())
    .rejects.toThrow('upload completion attempts are permanent');

  // Model a mistaken reset to the original sealed version, so dispatch reaches
  // the new fence rather than being rejected for a stale legacy version.
  await sql('UPDATE drive_upload_intents SET version = 2 WHERE id = ?', intent).run();
  await expect(dispatch('attempt-first')).rejects.toThrow('upload completion already attempted');
  const fetch = vi.fn(), verify = vi.fn(async () => parts);
  await expect(producer(fetch, verify).complete(token, 'attempt-first')).resolves.toBe('not-admitted');
  expect(verify).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(await evidence('dispatches', 'attempt-first')).toBeNull();
  expect(await storedAttempt(intent)).toMatchObject({ version: 2 });
});

it.each(['revocation', 'tombstone'])('does not record an attempt or fence cleanup after %s', async (veto) => {
  const { intent } = await sized(veto);
  if (veto === 'revocation') {
    await sql("UPDATE drive_principals SET status = 'revoked' WHERE id = ?", `owner-${veto}`).run();
  } else {
    await sql('INSERT INTO drive_upload_publication_tombstones VALUES (?)', intent).run();
  }
  await expect(attempt(await intentRow(intent))).rejects.toThrow('upload completion claim is stale');
  expect(await storedAttempt(intent)).toBeNull();
  expect(await intentRow(intent)).toMatchObject({ state: 'allocated', version: 2 });
  await cleanup(intent);
});

it('rolls back the attempt when cleanup claimed first', async () => {
  const { intent } = await sized('cleanup-first');
  await cleanup(intent);
  await expect(attempt(await intentRow(intent))).rejects.toThrow('upload cleanup already claimed');
  expect(await storedAttempt(intent)).toBeNull();
  expect(await intentRow(intent)).toMatchObject({ state: 'allocated', version: 2 });
  expect(await sql('SELECT intent_id FROM drive_upload_cleanup_claims WHERE intent_id = ?', intent).first())
    .toEqual({ intent_id: intent });
});

it('rejects an attempt when a legacy dispatch won before the journal reset', async () => {
  const { intent } = await sized('dispatch-first');
  await dispatch('dispatch-first');
  expect(await intents.recordNotDispatched('owner-dispatch-first', intent, 3, 'completion')).toBe(true);
  const row = await intentRow(intent);
  expect(row).toMatchObject({ state: 'allocated', version: 4 });
  await expect(attempt(row)).rejects.toThrow('upload completion already attempted');
  expect(await storedAttempt(intent)).toBeNull();
  expect(await intentRow(intent)).toMatchObject({ state: 'allocated', version: 4 });
  expect(await evidence('dispatches', 'dispatch-first')).toMatchObject({ claim_version: 3 });
});
