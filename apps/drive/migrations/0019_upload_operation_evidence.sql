-- Inert completion evidence only. No legacy backfill, dispatch claim or provenance.
-- The reservation, not the mutable journal, anchors evidence after intent removal.
CREATE TABLE drive_upload_completion_operations (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK (length(operation_id) > 0),
  intent_id TEXT NOT NULL REFERENCES drive_upload_intent_reservations (intent_id),
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  storage_epoch TEXT NOT NULL CHECK (length(storage_epoch) > 0),
  upload_id TEXT NOT NULL CHECK (length(upload_id) > 0),
  intent_version INTEGER NOT NULL CHECK (typeof(intent_version) = 'integer' AND intent_version BETWEEN 0 AND 9007199254740991),
  UNIQUE (intent_id, intent_version)
) STRICT, WITHOUT ROWID;
CREATE TABLE drive_upload_completion_evidence (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_completion_operations (operation_id),
  receipt_bytes BLOB NOT NULL CHECK (typeof(receipt_bytes) = 'blob' AND length(receipt_bytes) BETWEEN 1 AND 65536)
) STRICT, WITHOUT ROWID;

-- Check both uniqueness keys before SQLite can apply an outer conflict policy.
CREATE TRIGGER drive_upload_completion_operations_guard_insert
BEFORE INSERT ON drive_upload_completion_operations
WHEN EXISTS (SELECT 1 FROM drive_upload_completion_operations
  WHERE operation_id = NEW.operation_id OR (intent_id = NEW.intent_id AND intent_version = NEW.intent_version))
  OR NOT EXISTS (SELECT 1 FROM drive_upload_intent_reservations
    WHERE intent_id = NEW.intent_id AND owner_id = NEW.owner_id AND object_key = NEW.object_key)
BEGIN
  SELECT RAISE(ABORT, 'invalid or duplicate upload completion operation');
END;
CREATE TRIGGER drive_upload_completion_operations_no_update
BEFORE UPDATE ON drive_upload_completion_operations
BEGIN SELECT RAISE(ABORT, 'upload completion operations are immutable'); END;
CREATE TRIGGER drive_upload_completion_operations_no_delete
BEFORE DELETE ON drive_upload_completion_operations
BEGIN SELECT RAISE(ABORT, 'upload completion operations are permanent'); END;

CREATE TRIGGER drive_upload_completion_evidence_guard_insert
BEFORE INSERT ON drive_upload_completion_evidence
WHEN EXISTS (SELECT 1 FROM drive_upload_completion_evidence WHERE operation_id = NEW.operation_id)
  OR NOT EXISTS (SELECT 1 FROM drive_upload_completion_operations WHERE operation_id = NEW.operation_id)
  OR typeof(NEW.receipt_bytes) <> 'blob' OR length(NEW.receipt_bytes) NOT BETWEEN 1 AND 65536
BEGIN
  SELECT RAISE(ABORT, 'invalid or duplicate upload completion evidence');
END;
CREATE TRIGGER drive_upload_completion_evidence_no_update
BEFORE UPDATE ON drive_upload_completion_evidence
BEGIN SELECT RAISE(ABORT, 'upload completion evidence is immutable'); END;
CREATE TRIGGER drive_upload_completion_evidence_no_delete
BEFORE DELETE ON drive_upload_completion_evidence
BEGIN SELECT RAISE(ABORT, 'upload completion evidence is permanent'); END;
