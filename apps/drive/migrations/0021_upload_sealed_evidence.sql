-- Historical observations only. No backfill, dispatch claim or legacy-writer fence.
CREATE TABLE drive_upload_sealed_snapshots (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_completion_operations (operation_id),
  -- Each intent/part-number slot already binds permanent operation and report rows.
  part_numbers TEXT NOT NULL CHECK (length(CAST(part_numbers AS BLOB)) BETWEEN 3 AND 48895),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 167772160000)
) STRICT, WITHOUT ROWID;
CREATE TABLE drive_upload_sealed_reports (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_sealed_snapshots (operation_id),
  report_bytes BLOB NOT NULL CHECK (length(report_bytes) BETWEEN 1 AND 65536)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER drive_upload_sealed_snapshots_guard_insert
BEFORE INSERT ON drive_upload_sealed_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM drive_upload_completion_operations o
  JOIN drive_upload_intents i ON i.id = o.intent_id AND i.owner_id = o.owner_id AND i.object_key = o.object_key
  JOIN drive_active_members m ON m.id = i.owner_id
  WHERE o.operation_id = NEW.operation_id AND i.state = 'allocated' AND i.completion_acknowledged = 0
    AND i.version = o.intent_version AND i.upload_id = o.upload_id
    -- Admit only identities the bounded server API can bind and reconcile.
    AND length(CAST(o.operation_id AS BLOB)) BETWEEN 1 AND 196608
    AND length(CAST(o.intent_id AS BLOB)) BETWEEN 1 AND 196608
    AND length(CAST(o.owner_id AS BLOB)) BETWEEN 1 AND 196608
    AND length(CAST(o.object_key AS BLOB)) BETWEEN 1 AND 196608
    AND length(CAST(o.storage_epoch AS BLOB)) BETWEEN 1 AND 196608
    AND length(CAST(o.upload_id AS BLOB)) BETWEEN 1 AND 196608
    AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_operations prior
      LEFT JOIN drive_upload_sealed_snapshots s USING (operation_id)
      LEFT JOIN drive_upload_completion_evidence e USING (operation_id)
      WHERE prior.intent_id = o.intent_id AND (s.operation_id IS NOT NULL OR e.operation_id IS NOT NULL))
    AND (
      -- Compare canonical JSON of slots. Keep ETags as opaque ledger blobs;
      -- this snapshot neither parses them nor supplies a provider manifest.
      SELECT json_group_array(part_number) IS NEW.part_numbers AND sum(size_bytes) = NEW.size_bytes
        AND count(*) > 0 AND min(present) = 1
        AND (sum(size_bytes < 5242880) = 0 OR (sum(size_bytes < 5242880) = 1
          AND max(CASE WHEN size_bytes < 5242880 THEN part_number END) = max(part_number)))
      FROM (
        SELECT p.part_number, p.size_bytes, (p.owner_id = o.owner_id AND p.object_key = o.object_key
          AND p.storage_epoch = o.storage_epoch AND p.upload_id = o.upload_id AND p.intent_version = o.intent_version
          AND r.operation_id IS NOT NULL AND u.operation_id IS NULL) AS present
        FROM drive_upload_part_operations p
        LEFT JOIN drive_upload_part_observations r ON r.operation_id = p.operation_id AND r.kind = 'reported'
        LEFT JOIN drive_upload_part_observations u ON u.operation_id = p.operation_id AND u.kind = 'uncertain'
        WHERE p.intent_id = o.intent_id ORDER BY p.part_number
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'invalid or duplicate sealed upload snapshot'); END;
CREATE TRIGGER drive_upload_sealed_snapshots_no_update
BEFORE UPDATE ON drive_upload_sealed_snapshots
BEGIN SELECT RAISE(ABORT, 'sealed upload snapshots are immutable'); END;
CREATE TRIGGER drive_upload_sealed_snapshots_no_delete
BEFORE DELETE ON drive_upload_sealed_snapshots
BEGIN SELECT RAISE(ABORT, 'sealed upload snapshots are permanent'); END;

-- No live intent join: a late report is retained even after revocation or removal.
CREATE TRIGGER drive_upload_sealed_reports_guard_insert
BEFORE INSERT ON drive_upload_sealed_reports
WHEN EXISTS (SELECT 1 FROM drive_upload_sealed_reports WHERE operation_id = NEW.operation_id)
  OR NOT EXISTS (SELECT 1 FROM drive_upload_sealed_snapshots WHERE operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'invalid or duplicate sealed upload report'); END;
CREATE TRIGGER drive_upload_sealed_reports_no_update
BEFORE UPDATE ON drive_upload_sealed_reports
BEGIN SELECT RAISE(ABORT, 'sealed upload reports are immutable'); END;
CREATE TRIGGER drive_upload_sealed_reports_no_delete
BEFORE DELETE ON drive_upload_sealed_reports
BEGIN SELECT RAISE(ABORT, 'sealed upload reports are permanent'); END;
