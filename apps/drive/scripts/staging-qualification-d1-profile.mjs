import { createHash } from 'node:crypto';

// Fully migrated post-#324 profile. Review a new migration tree and catalog
// together before expanding this profile. Pre-migration databases fail closed.
export const reviewedMigrationTree = 'adb6cdb75652492064dc90d3c49335bbbddae74d';
const catalogSize = 167;
const catalogHash = 'ac4c24f3875bd1c8ede294207b16928c2c0ae6dae7523ad82591ee54761da861';
const appTables = [
  'drive_bound_ceremonies',
  'drive_credentials',
  'drive_deleted_entries',
  'drive_entries',
  'drive_folder_counts',
  'drive_invitations',
  'drive_login_generations',
  'drive_object_deletion_jobs',
  'drive_owner_registration',
  'drive_owner_usage',
  'drive_principals',
  'drive_read_grants',
  'drive_recovery_tokens',
  'drive_sessions',
  'drive_upload_cleanup_claims',
  'drive_upload_completion_dispatches',
  'drive_upload_completion_evidence',
  'drive_upload_completion_operations',
  'drive_upload_completion_quarantine',
  'drive_upload_completion_receipts',
  'drive_upload_intent_reservations',
  'drive_upload_intents',
  'drive_upload_key_reservations',
  'drive_upload_part_byte_evidence',
  'drive_upload_part_observations',
  'drive_upload_part_operations',
  'drive_upload_publication_attempts',
  'drive_upload_publication_tombstones',
  'drive_upload_publications',
  'drive_upload_sealed_reports',
  'drive_upload_sealed_snapshots',
  'drive_upload_storage_bindings',
  'drive_webauthn_challenges',
];

// One SQLite snapshot for the row checks and schema. The compact catalog
// projection fits the D1 read budget. Fetch one extra row to detect overflow.
// The only bookkeeping tables are the reviewed Wrangler ledger and sequence.
export const censusSql = `WITH expected_migrations AS (SELECT value AS name FROM json_each(?))
  SELECT t, s FROM (
    SELECT 0 AS ordinal, '' AS type, '' AS name, '' AS t,
      CASE WHEN ${appTables.map(table => `EXISTS (SELECT 1 FROM main.${table})`).join('\n        OR ')}
        OR (SELECT count(*) FROM main.d1_migrations) <> (SELECT count(*) FROM expected_migrations)
        OR EXISTS (SELECT name FROM expected_migrations EXCEPT SELECT name FROM main.d1_migrations)
        OR EXISTS (SELECT 1 FROM main.d1_migrations WHERE id < 1
          OR typeof(applied_at) <> 'text' OR strftime('%Y-%m-%d %H:%M:%S', applied_at) IS NOT applied_at)
        OR (SELECT count(*) FROM main.sqlite_sequence) <> 1
        OR NOT EXISTS (SELECT 1 FROM main.sqlite_sequence WHERE name = 'd1_migrations'
          AND typeof(seq) = 'integer' AND seq = (SELECT max(id) FROM main.d1_migrations))
      THEN 'blocked' ELSE 'empty' END AS s
    UNION ALL
    SELECT 1, type, name, CASE WHEN type = 'table' THEN name ELSE '' END,
      CASE WHEN sql IS NULL THEN type || ':' || name || ':' || tbl_name ELSE sql END
    FROM main.sqlite_schema
  ) ORDER BY ordinal, type COLLATE BINARY, name COLLATE BINARY LIMIT ${catalogSize + 2}`;

export function assertReviewedEmptyCatalog(rows) {
  if (rows.length !== catalogSize + 1 || rows.some(row =>
    typeof row?.t !== 'string' || typeof row.s !== 'string' || Object.keys(row).length !== 2)) throw new Error();
  const [verdict, ...catalog] = rows;
  const tables = catalog.map(({ t }) => t).filter(Boolean);
  const digest = createHash('sha256').update(JSON.stringify(catalog.map(({ t, s }) => [t, s]))).digest('hex');
  if (verdict.t !== '' || verdict.s !== 'empty' || digest !== catalogHash ||
      JSON.stringify(tables) !== JSON.stringify(['d1_migrations', ...appTables, 'sqlite_sequence'])) throw new Error();
}
