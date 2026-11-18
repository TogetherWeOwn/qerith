import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

const migration = '0020_upload_part_operation_evidence.sql';
const migrate = (limit) => applyD1Migrations(env.DB, env.DRIVE_MIGRATIONS.filter(({ name }) => name <= limit));
const rows = async (sql) => (await env.DB.prepare(sql).all()).results;

it('upgrades 0019 without inferring part evidence from legacy rows', async () => {
  await migrate('0019_upload_operation_evidence.sql');
  expect(await rows("SELECT name FROM sqlite_master WHERE name GLOB 'drive_upload_part_*'")).toEqual([]);
  await env.DB.prepare("INSERT INTO drive_principals VALUES ('legacy-owner', 'member', 'active')").run();
  await env.DB.prepare(`INSERT INTO drive_upload_intents
    (id, owner_id, object_key, upload_id, version, state, completion_acknowledged) VALUES
    ('legacy-allocated', 'legacy-owner', 'key-allocated', 'upload-a', 2, 'allocated', 0),
    ('legacy-acknowledged', 'legacy-owner', 'key-acknowledged', 'upload-b', 4, 'acknowledged', 1)`).run();
  const journal = 'SELECT * FROM drive_upload_intents ORDER BY id';
  const before = await rows(journal);
  await migrate(migration);
  await migrate(migration);
  expect(await rows(journal)).toEqual(before);
  expect(await rows('SELECT * FROM drive_upload_part_operations')).toEqual([]);
  expect(await rows('SELECT * FROM drive_upload_part_observations')).toEqual([]);
});
