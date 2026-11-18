-- Historical observations only. No backfill, dispatch claim or legacy-writer fence.
CREATE TABLE drive_upload_sealed_snapshots (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_completion_operations (operation_id),
  manifest TEXT NOT NULL CHECK (length(CAST(manifest AS BLOB)) BETWEEN 1 AND 262144),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 167772160000)
) STRICT, WITHOUT ROWID;
CREATE TABLE drive_upload_sealed_reports (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_sealed_snapshots (operation_id),
  report_bytes BLOB NOT NULL CHECK (length(report_bytes) BETWEEN 1 AND 65536)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER drive_upload_sealed_snapshots_guard_insert
BEFORE INSERT ON drive_upload_sealed_snapshots
BEGIN
  SELECT CASE WHEN length(CAST(NEW.manifest AS BLOB)) NOT BETWEEN 1 AND 262144
    OR json_valid(NEW.manifest) IS NOT 1 THEN RAISE(ABORT, 'invalid sealed upload snapshot') END;
  SELECT CASE WHEN json_type(NEW.manifest) IS NOT 'array'
    OR json_array_length(NEW.manifest) NOT BETWEEN 1 AND 10000
    OR NOT EXISTS (
      SELECT 1 FROM drive_upload_completion_operations o
      JOIN drive_upload_intents i ON i.id = o.intent_id AND i.owner_id = o.owner_id AND i.object_key = o.object_key
      JOIN drive_active_members m ON m.id = i.owner_id
      WHERE o.operation_id = NEW.operation_id AND i.state = 'allocated' AND i.completion_acknowledged = 0
        AND i.version = o.intent_version AND i.upload_id = o.upload_id
        AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_operations prior
          LEFT JOIN drive_upload_sealed_snapshots s USING (operation_id)
          LEFT JOIN drive_upload_completion_evidence e USING (operation_id)
          WHERE prior.intent_id = o.intent_id AND (s.operation_id IS NOT NULL OR e.operation_id IS NOT NULL))
        AND (SELECT count(*) = json_array_length(NEW.manifest) AND sum(size_bytes) = NEW.size_bytes
          FROM drive_upload_part_operations WHERE intent_id = o.intent_id)
        AND NOT EXISTS (
          SELECT 1 FROM (
            SELECT value, json_extract(value, '$.partNumber') AS part_number,
              lag(json_extract(value, '$.partNumber'), 1, 0) OVER (ORDER BY key) AS previous
            FROM json_each(NEW.manifest)
          ) part
          LEFT JOIN drive_upload_part_operations p ON p.intent_id = o.intent_id AND p.part_number = part.part_number
            AND p.owner_id = o.owner_id AND p.object_key = o.object_key AND p.storage_epoch = o.storage_epoch
            AND p.upload_id = o.upload_id AND p.intent_version = o.intent_version
          LEFT JOIN drive_upload_part_observations r ON r.operation_id = p.operation_id AND r.kind = 'reported'
          WHERE part.part_number <= part.previous OR r.reported_etag IS NULL
            OR CAST(json_extract(part.value, '$.etag') AS BLOB) IS NOT r.reported_etag
            OR part.value IS NOT json_object('operationId', p.operation_id, 'partNumber', p.part_number,
              'etag', CAST(r.reported_etag AS TEXT), 'size', p.size_bytes)
            OR EXISTS (SELECT 1 FROM drive_upload_part_observations u
              WHERE u.operation_id = p.operation_id AND u.kind = 'uncertain')
        )
    ) THEN RAISE(ABORT, 'invalid or duplicate sealed upload snapshot') END;
END;
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
