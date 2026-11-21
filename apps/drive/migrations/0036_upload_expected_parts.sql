-- NULL is permanently unbound. Otherwise slot n is the nth 64-character,
-- lowercase hex SHA-256. Its byte count comes from the immutable declared_size
-- and the fixed 16 MiB plan (one slot even for a zero-byte declaration).
ALTER TABLE drive_upload_intents ADD COLUMN expected_part_sha256s TEXT CHECK (
  expected_part_sha256s IS NULL OR (
    declared_size IS NOT NULL AND declared_size BETWEEN 0 AND 5368709120
    AND typeof(expected_part_sha256s) = 'text'
    AND length(expected_part_sha256s) = 64 * max(1, (declared_size + 16777215) / 16777216)
    AND length(CAST(expected_part_sha256s AS BLOB)) = length(expected_part_sha256s)
    AND expected_part_sha256s NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE TRIGGER drive_upload_expected_parts_new_intent
BEFORE INSERT ON drive_upload_intents
WHEN NEW.expected_part_sha256s IS NOT NULL AND (
  NEW.state <> 'created' OR NEW.version <> 0 OR NEW.upload_id IS NOT NULL OR NEW.completion_acknowledged <> 0
)
BEGIN SELECT RAISE(ABORT, 'expected upload parts require a new intent'); END;

CREATE TRIGGER drive_upload_expected_parts_immutable
BEFORE UPDATE OF expected_part_sha256s ON drive_upload_intents
WHEN NEW.expected_part_sha256s IS NOT OLD.expected_part_sha256s
BEGIN SELECT RAISE(ABORT, 'expected upload parts are immutable'); END;
