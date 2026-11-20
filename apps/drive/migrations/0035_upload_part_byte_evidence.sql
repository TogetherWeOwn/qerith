-- Only the current, still-open allocation is eligible for byte evidence.
CREATE VIEW drive_upload_resumable_part_operations AS
SELECT o.*, b.endpoint, b.bucket
FROM drive_upload_part_operations o
JOIN drive_upload_storage_bindings b ON b.intent_id = o.intent_id AND b.storage_epoch = o.storage_epoch
JOIN drive_upload_intents i ON i.id = o.intent_id AND i.owner_id = o.owner_id AND i.object_key = o.object_key
JOIN drive_active_members m ON m.id = i.owner_id
WHERE i.state = 'allocated' AND i.completion_acknowledged = 0 AND i.upload_id = o.upload_id
  AND i.version = o.intent_version AND i.version < 9007199254740990 AND i.declared_size IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_operations WHERE intent_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones WHERE intent_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_attempts WHERE intent_id = i.id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_part_observations WHERE operation_id = o.operation_id AND kind = 'uncertain');

-- The permanent operation and immutable storage binding carry the byte identity's scope.
CREATE TABLE drive_upload_part_byte_evidence (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_part_operations (operation_id),
  sha256 BLOB NOT NULL CHECK (length(sha256) = 32),
  reported_etag BLOB NOT NULL CHECK (length(reported_etag) BETWEEN 1 AND 8192)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER drive_upload_part_byte_evidence_guard_insert
BEFORE INSERT ON drive_upload_part_byte_evidence
WHEN EXISTS (SELECT 1 FROM drive_upload_part_byte_evidence WHERE operation_id = NEW.operation_id)
  OR EXISTS (SELECT 1 FROM drive_upload_part_observations WHERE operation_id = NEW.operation_id)
  OR NOT EXISTS (SELECT 1 FROM drive_upload_resumable_part_operations WHERE operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'invalid or duplicate upload part byte evidence'); END;

-- Record the first receipt in the same statement. Never retrofit a digest onto
-- old receipts, and keep the existing observation/seal contract unchanged.
CREATE TRIGGER drive_upload_part_byte_evidence_report
AFTER INSERT ON drive_upload_part_byte_evidence
BEGIN
  INSERT INTO drive_upload_part_observations (operation_id, kind, reported_etag)
  VALUES (NEW.operation_id, 'reported', NEW.reported_etag);
END;

CREATE TRIGGER drive_upload_part_byte_evidence_no_update
BEFORE UPDATE ON drive_upload_part_byte_evidence
BEGIN SELECT RAISE(ABORT, 'upload part byte evidence is immutable'); END;
CREATE TRIGGER drive_upload_part_byte_evidence_no_delete
BEFORE DELETE ON drive_upload_part_byte_evidence
BEGIN SELECT RAISE(ABORT, 'upload part byte evidence is permanent'); END;
