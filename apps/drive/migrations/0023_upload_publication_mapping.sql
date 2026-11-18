-- Inert atomic mapping. No backfill, cleanup effects or read resolver.
-- Bind the original destination even if the entry later moves.
CREATE TABLE drive_upload_publications (
  entry_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  evidence_revision TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  FOREIGN KEY (operation_id, evidence_revision)
    REFERENCES drive_upload_completion_receipts (operation_id, evidence_revision)
) STRICT, WITHOUT ROWID;

CREATE VIEW drive_upload_publishable_receipts AS
SELECT o.operation_id, o.owner_id, o.object_key, o.storage_epoch, s.size_bytes,
  d.endpoint, d.bucket, d.session_hash, r.evidence_revision, r.etag
FROM drive_upload_completion_operations o
JOIN drive_upload_sealed_snapshots s USING (operation_id)
JOIN drive_upload_completion_dispatches d USING (operation_id)
JOIN drive_upload_completion_receipts r USING (operation_id)
JOIN drive_upload_storage_bindings b ON b.intent_id = o.intent_id AND b.storage_epoch = o.storage_epoch
  AND b.endpoint = d.endpoint AND b.bucket = d.bucket
JOIN drive_upload_intents i ON i.id = o.intent_id AND i.owner_id = o.owner_id AND i.object_key = o.object_key
JOIN drive_active_members m ON m.id = i.owner_id
JOIN drive_sessions auth ON auth.principal_id = i.owner_id AND auth.token_hash = d.session_hash
  AND auth.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE i.state = 'completing' AND i.completion_acknowledged = 0 AND i.version = d.claim_version
  AND i.upload_id = o.upload_id
  AND NOT EXISTS (SELECT 1 FROM drive_entries e WHERE e.object_key = o.object_key)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_completion_quarantine q WHERE q.operation_id = o.operation_id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones t WHERE t.intent_id = o.intent_id)
  AND NOT EXISTS (
    SELECT 1 FROM drive_upload_part_operations p JOIN drive_upload_part_observations u USING (operation_id)
    WHERE p.intent_id = o.intent_id AND u.kind = 'uncertain'
  );

-- Abort before inserting the map even if the outer statement uses OR FAIL.
CREATE TRIGGER drive_upload_publications_guard_insert
BEFORE INSERT ON drive_upload_publications
WHEN length(NEW.entry_id) = 0 OR length(CAST(NEW.name AS BLOB)) NOT BETWEEN 1 AND 255
  OR length(trim(NEW.name, ' .')) = 0 OR instr(NEW.name, '/') != 0 OR instr(NEW.name, char(0)) != 0
  OR EXISTS (SELECT 1 FROM drive_upload_publications WHERE entry_id = NEW.entry_id OR operation_id = NEW.operation_id)
  OR NOT EXISTS (
    SELECT 1 FROM drive_upload_publishable_receipts r WHERE r.operation_id = NEW.operation_id
      AND r.owner_id = NEW.owner_id AND r.evidence_revision = NEW.evidence_revision
  )
BEGIN SELECT RAISE(ABORT, 'invalid or duplicate upload publication'); END;
CREATE TRIGGER drive_upload_publications_commit
AFTER INSERT ON drive_upload_publications
BEGIN
  -- Existing metadata constraints enforce parent ownership and name/key uniqueness.
  INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
    SELECT NEW.entry_id, NEW.owner_id, NEW.parent_id, NEW.name, 'file', o.object_key, s.size_bytes
    FROM drive_upload_completion_operations o JOIN drive_upload_sealed_snapshots s USING (operation_id)
    WHERE o.operation_id = NEW.operation_id;
  -- An outer conflict policy can suppress a constraint failure inside this trigger.
  -- The projection above supplies the exact row; existing IDs cannot satisfy the insert.
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'missing publication entry') END;
  UPDATE drive_upload_intents SET state = 'acknowledged', completion_acknowledged = 1, version = version + 1
    WHERE id = (SELECT intent_id FROM drive_upload_completion_operations WHERE operation_id = NEW.operation_id);
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'missing publication acknowledgement') END;
END;
CREATE TRIGGER drive_upload_publications_no_update BEFORE UPDATE ON drive_upload_publications
BEGIN SELECT RAISE(ABORT, 'upload publications are immutable'); END;
CREATE TRIGGER drive_upload_publications_no_delete BEFORE DELETE ON drive_upload_publications
BEGIN SELECT RAISE(ABORT, 'upload publications are permanent'); END;

-- Fence both write orders; pre-migration overlaps are ineligible above.
CREATE TRIGGER drive_upload_reservations_no_entry BEFORE INSERT ON drive_upload_key_reservations
WHEN EXISTS (SELECT 1 FROM drive_entries WHERE object_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'upload key already names an entry'); END;

-- Reserved keys and mapped entry IDs cannot be adopted by ordinary writers.
CREATE TRIGGER drive_entries_require_publication
BEFORE INSERT ON drive_entries
WHEN (EXISTS (SELECT 1 FROM drive_upload_key_reservations WHERE object_key = NEW.object_key)
  OR EXISTS (SELECT 1 FROM drive_upload_publications WHERE entry_id = NEW.id))
  AND NOT EXISTS (
    SELECT 1 FROM drive_upload_publications p JOIN drive_upload_publishable_receipts r USING (operation_id, evidence_revision)
    WHERE p.entry_id = NEW.id AND p.owner_id = NEW.owner_id AND p.parent_id IS NEW.parent_id
      AND p.name = NEW.name AND r.object_key = NEW.object_key AND r.size_bytes = NEW.size_bytes
  )
BEGIN SELECT RAISE(ABORT, 'entry requires trusted upload publication'); END;

CREATE TRIGGER drive_entries_keep_publication_size BEFORE UPDATE OF size_bytes ON drive_entries
WHEN NEW.size_bytes IS NOT OLD.size_bytes
  AND EXISTS (SELECT 1 FROM drive_upload_publications WHERE entry_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'immutable publication size'); END;

-- Tombstoning removes read authority before metadata can be deleted. It does
-- not authorize provider cleanup; that transition is separate and unwired.
CREATE TRIGGER drive_entries_keep_live_publication
BEFORE DELETE ON drive_entries
WHEN EXISTS (
  SELECT 1 FROM drive_upload_publications p JOIN drive_upload_completion_operations o USING (operation_id)
  WHERE p.entry_id = OLD.id AND NOT EXISTS (
    SELECT 1 FROM drive_upload_publication_tombstones t WHERE t.intent_id = o.intent_id
  )
)
BEGIN SELECT RAISE(ABORT, 'upload publication is not tombstoned'); END;

-- Server-internal join surface, not authorization. Consumers must join live
-- authorization and select the view in the same fresh primary statement.
CREATE VIEW drive_upload_publication_refs AS
SELECT p.entry_id, p.owner_id, json_array(d.endpoint, d.bucket, o.storage_epoch) AS storage_config_id,
  o.object_key, r.etag, s.size_bytes, r.evidence_revision
FROM drive_upload_publications p
JOIN drive_upload_completion_receipts r USING (operation_id, evidence_revision)
JOIN drive_upload_completion_dispatches d USING (operation_id)
JOIN drive_upload_completion_operations o USING (operation_id)
JOIN drive_upload_sealed_snapshots s USING (operation_id)
JOIN drive_entries e ON e.id = p.entry_id AND e.owner_id = p.owner_id AND e.kind = 'file'
  AND e.object_key = o.object_key AND e.size_bytes = s.size_bytes
WHERE NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones t WHERE t.intent_id = o.intent_id);
