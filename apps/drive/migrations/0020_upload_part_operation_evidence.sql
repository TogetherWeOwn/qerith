-- Evidence only: no backfill, existing-writer fence, or provider authority.
CREATE TABLE drive_upload_part_operations (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128
    AND length(operation_id) = length(CAST(operation_id AS BLOB)) AND operation_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  intent_id TEXT NOT NULL REFERENCES drive_upload_intent_reservations (intent_id),
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  storage_epoch TEXT NOT NULL CHECK (length(storage_epoch) BETWEEN 1 AND 128
    AND length(storage_epoch) = length(CAST(storage_epoch AS BLOB)) AND storage_epoch NOT GLOB '*[^A-Za-z0-9._:-]*'),
  -- Match the allocation journal's 65536 UTF-16 code units, at up to 3 UTF-8 bytes per unit.
  upload_id TEXT NOT NULL CHECK (length(CAST(upload_id AS BLOB)) BETWEEN 1 AND 196608),
  intent_version INTEGER NOT NULL CHECK (intent_version BETWEEN 0 AND 9007199254740991),
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 16777216),
  UNIQUE (intent_id, part_number)
) STRICT, WITHOUT ROWID;

-- A second write to the same part can replace provider bytes. In this ledger
-- neither uncertainty, a reported result, nor a new journal version frees a slot.
CREATE TRIGGER drive_upload_part_operations_guard_insert
BEFORE INSERT ON drive_upload_part_operations
WHEN EXISTS (SELECT 1 FROM drive_upload_part_operations
  WHERE operation_id = NEW.operation_id OR (intent_id = NEW.intent_id AND part_number = NEW.part_number))
  OR NOT EXISTS (SELECT 1 FROM drive_upload_intent_reservations r
    JOIN drive_upload_intents i ON i.id = r.intent_id
    JOIN drive_active_members m ON m.id = i.owner_id
    WHERE r.intent_id = NEW.intent_id AND r.owner_id = NEW.owner_id AND r.object_key = NEW.object_key
      AND i.owner_id = r.owner_id AND i.object_key = r.object_key AND i.state = 'allocated'
      AND i.completion_acknowledged = 0 AND i.version = NEW.intent_version AND i.upload_id = NEW.upload_id)
BEGIN SELECT RAISE(ABORT, 'invalid or duplicate upload part operation'); END;
CREATE TRIGGER drive_upload_part_operations_no_update
BEFORE UPDATE ON drive_upload_part_operations
BEGIN SELECT RAISE(ABORT, 'upload part operations are immutable'); END;
CREATE TRIGGER drive_upload_part_operations_no_delete
BEFORE DELETE ON drive_upload_part_operations
BEGIN SELECT RAISE(ABORT, 'upload part operations are permanent'); END;

-- Keep uncertainty and a late report independently. Neither proves that the
-- provider received bytes, and a report does not erase uncertainty.
CREATE TABLE drive_upload_part_observations (
  operation_id TEXT NOT NULL REFERENCES drive_upload_part_operations (operation_id),
  kind TEXT NOT NULL,
  reported_etag BLOB,
  PRIMARY KEY (operation_id, kind)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER drive_upload_part_observations_guard_insert
BEFORE INSERT ON drive_upload_part_observations
WHEN EXISTS (SELECT 1 FROM drive_upload_part_observations
  WHERE operation_id = NEW.operation_id AND kind = NEW.kind)
  OR NOT EXISTS (SELECT 1 FROM drive_upload_part_operations WHERE operation_id = NEW.operation_id)
  OR NOT ((NEW.kind IS 'uncertain' AND NEW.reported_etag IS NULL)
    OR (NEW.kind IS 'reported' AND typeof(NEW.reported_etag) = 'blob'
      AND length(NEW.reported_etag) BETWEEN 1 AND 8192))
BEGIN SELECT RAISE(ABORT, 'invalid or duplicate upload part observation'); END;
CREATE TRIGGER drive_upload_part_observations_no_update
BEFORE UPDATE ON drive_upload_part_observations
BEGIN SELECT RAISE(ABORT, 'upload part observations are immutable'); END;
CREATE TRIGGER drive_upload_part_observations_no_delete
BEFORE DELETE ON drive_upload_part_observations
BEGIN SELECT RAISE(ABORT, 'upload part observations are permanent'); END;
