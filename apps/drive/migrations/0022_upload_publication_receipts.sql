-- No backfill or caller wiring. Only a signed completion response can supply a receipt.
CREATE TABLE drive_upload_completion_dispatches (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_sealed_snapshots (operation_id),
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  bucket TEXT NOT NULL CHECK (length(bucket) BETWEEN 3 AND 63),
  claim_version INTEGER NOT NULL CHECK (claim_version BETWEEN 1 AND 9007199254740990),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  session_hash TEXT NOT NULL CHECK (length(session_hash) = 64 AND session_hash NOT GLOB '*[^0-9a-f]*')
) STRICT, WITHOUT ROWID;

CREATE TABLE drive_upload_completion_receipts (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_completion_dispatches (operation_id),
  evidence_revision TEXT NOT NULL CHECK (length(evidence_revision) = 36),
  etag TEXT NOT NULL CHECK (length(CAST(etag AS BLOB)) BETWEEN 2 AND 65536
    AND substr(etag, 1, 1) = '"' AND substr(etag, -1) = '"' AND instr(etag, char(0)) = 0
    AND substr(etag, 2, length(etag) - 2) NOT GLOB ('*[^!#-~' || char(128) || '-' || char(255) || ']*')),
  response_checksums TEXT NOT NULL CHECK (json_valid(response_checksums) AND length(CAST(response_checksums AS BLOB)) <= 131072),
  UNIQUE (operation_id, evidence_revision)
) STRICT, WITHOUT ROWID;

-- Recovery can fence an unresolved dispatch, but cannot settle or repeat it.
CREATE TABLE drive_upload_completion_quarantine (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_completion_dispatches (operation_id)
) STRICT, WITHOUT ROWID;

-- A future cleanup transition must acquire this intent-wide fence before any
-- cleanup effects. A tombstone alone neither settles a dispatch nor permits deletion.
CREATE TABLE drive_upload_publication_tombstones (
  intent_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_intent_reservations (intent_id)
) STRICT, WITHOUT ROWID;

-- Recheck slots and uncertainty in the write transaction. Operation evidence
-- already references the immutable reservation and binds the owner/key to it.
CREATE VIEW drive_upload_sealed_candidates AS
SELECT o.*, s.part_numbers, s.size_bytes
FROM drive_upload_completion_operations o JOIN drive_upload_sealed_snapshots s USING (operation_id)
WHERE NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones t WHERE t.intent_id = o.intent_id)
  AND json_array_length(s.part_numbers) = (SELECT count(*) FROM drive_upload_part_operations p WHERE p.intent_id = o.intent_id)
  AND NOT EXISTS (
    SELECT 1 FROM drive_upload_part_operations p JOIN drive_upload_part_observations u USING (operation_id)
    WHERE p.intent_id = o.intent_id AND u.kind = 'uncertain'
  );

CREATE TRIGGER drive_upload_completion_dispatches_guard_insert
BEFORE INSERT ON drive_upload_completion_dispatches
WHEN EXISTS (SELECT 1 FROM drive_upload_completion_dispatches WHERE operation_id = NEW.operation_id)
  OR NOT EXISTS (
    SELECT 1 FROM drive_upload_sealed_candidates o
    JOIN drive_upload_intents i ON i.id = o.intent_id AND i.owner_id = o.owner_id AND i.object_key = o.object_key
    JOIN drive_active_members m ON m.id = i.owner_id
    JOIN drive_sessions auth ON auth.principal_id = i.owner_id AND auth.token_hash = NEW.session_hash
      AND auth.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE o.operation_id = NEW.operation_id AND i.state = 'allocated' AND i.completion_acknowledged = 0
      AND i.upload_id = o.upload_id AND i.version = o.intent_version AND NEW.claim_version = i.version + 1
  )
BEGIN SELECT RAISE(ABORT, 'invalid or duplicate upload dispatch'); END;
CREATE TRIGGER drive_upload_completion_dispatches_claim
AFTER INSERT ON drive_upload_completion_dispatches
BEGIN
  UPDATE drive_upload_intents SET state = 'completing', version = NEW.claim_version
    WHERE id = (SELECT intent_id FROM drive_upload_completion_operations WHERE operation_id = NEW.operation_id);
END;
CREATE TRIGGER drive_upload_completion_dispatches_no_update
BEFORE UPDATE ON drive_upload_completion_dispatches
BEGIN SELECT RAISE(ABORT, 'upload dispatches are immutable'); END;
CREATE TRIGGER drive_upload_completion_dispatches_no_delete
BEFORE DELETE ON drive_upload_completion_dispatches
BEGIN SELECT RAISE(ABORT, 'upload dispatches are permanent'); END;

-- A late signed result is historical evidence. Do not join the mutable intent,
-- session, or tombstone here, and never advance them when recording a receipt.
CREATE TRIGGER drive_upload_completion_receipts_no_replace
BEFORE INSERT ON drive_upload_completion_receipts
WHEN EXISTS (SELECT 1 FROM drive_upload_completion_receipts WHERE operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'duplicate upload receipt'); END;
CREATE TRIGGER drive_upload_completion_receipts_no_update
BEFORE UPDATE ON drive_upload_completion_receipts
BEGIN SELECT RAISE(ABORT, 'upload receipts are immutable'); END;
CREATE TRIGGER drive_upload_completion_receipts_no_delete
BEFORE DELETE ON drive_upload_completion_receipts
BEGIN SELECT RAISE(ABORT, 'upload receipts are permanent'); END;

CREATE TRIGGER drive_upload_completion_quarantine_no_update
BEFORE UPDATE ON drive_upload_completion_quarantine
BEGIN SELECT RAISE(ABORT, 'upload quarantine is immutable'); END;
CREATE TRIGGER drive_upload_completion_quarantine_no_delete
BEFORE DELETE ON drive_upload_completion_quarantine
BEGIN SELECT RAISE(ABORT, 'upload quarantine is permanent'); END;
CREATE TRIGGER drive_upload_publication_tombstones_no_update
BEFORE UPDATE ON drive_upload_publication_tombstones
BEGIN SELECT RAISE(ABORT, 'upload publication tombstones are immutable'); END;
CREATE TRIGGER drive_upload_publication_tombstones_no_delete
BEFORE DELETE ON drive_upload_publication_tombstones
BEGIN SELECT RAISE(ABORT, 'upload publication tombstones are permanent'); END;
