import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { UploadIntents } from '../../drive/src/lib/server/metadata/upload-intents.ts';
import { migrations, seed, sql } from './fixtures/upload-completion.mjs';

const attempt = (intent, version = 2) => sql(`INSERT INTO drive_upload_publication_attempts
  SELECT id, object_key, upload_id, ?, declared_size FROM drive_upload_intents WHERE id = ?`, version, intent).run();

it('atomically fences cleanup and legacy dispatch even after a mistaken journal reset', async () => {
  await applyD1Migrations(env.DB, migrations.filter(({ name }) => name <= '0027_upload_publications.sql'));
  const { intent } = await seed('attempt-reset', { sized: true });
  const intents = new UploadIntents(env.DB);
  await expect(attempt(intent, 1)).rejects.toThrow('upload completion claim is stale');
  expect(await sql('SELECT intent_id FROM drive_upload_publication_attempts WHERE intent_id = ?', intent).first()).toBeNull();
  await attempt(intent);
  expect(await intents.get('owner-attempt-reset', intent)).toMatchObject({ state: 'completing', version: 3 });
  expect(await intents.recordNotDispatched('owner-attempt-reset', intent, 3, 'completion')).toBe(true);
  await expect(sql('INSERT INTO drive_upload_cleanup_claims VALUES (?)', intent).run()).rejects.toThrow();
  await expect(intents.claim('owner-attempt-reset', intent, 4, 'completion')).resolves.toBeNull();
  // Insert directly: the candidate view excludes the reset version and would insert no row.
  await expect(sql(`INSERT INTO drive_upload_completion_dispatches VALUES (?, ?, ?, ?, ?, ?)`,
    'attempt-reset', 'https://storage.example', 'drive-test', 5, 'a'.repeat(64), 'b'.repeat(64)).run())
    .rejects.toThrow('upload completion already attempted');
  await expect(sql('UPDATE drive_upload_publication_attempts SET version = version WHERE intent_id = ?', intent).run()).rejects.toThrow();
  await expect(sql('DELETE FROM drive_upload_publication_attempts WHERE intent_id = ?', intent).run()).rejects.toThrow();
});

it('rolls back an attempt if cleanup already claimed the intent', async () => {
  await applyD1Migrations(env.DB, migrations.filter(({ name }) => name <= '0027_upload_publications.sql'));
  const { intent } = await seed('attempt-cleanup', { sized: true });
  await sql('INSERT INTO drive_upload_cleanup_claims VALUES (?)', intent).run();
  await expect(attempt(intent)).rejects.toThrow();
  expect(await sql('SELECT intent_id FROM drive_upload_publication_attempts WHERE intent_id = ?', intent).first()).toBeNull();
  expect(await new UploadIntents(env.DB).get('owner-attempt-cleanup', intent)).toMatchObject({ state: 'allocated', version: 2 });
});
