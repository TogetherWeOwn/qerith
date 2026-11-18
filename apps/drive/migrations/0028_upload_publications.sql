-- A publication is retained even if its visible entry is later removed.
CREATE TABLE drive_upload_publications (
  intent_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_intent_reservations(intent_id),
  intent_version INTEGER NOT NULL,
  entry_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  parent_id TEXT,
  name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  object_etag TEXT NOT NULL CHECK (length(object_etag) > 0)
) STRICT, WITHOUT ROWID;

-- The attempt records the version before the atomic claim increments it.
-- It fences competing writes; provider evidence must come from the caller.
CREATE TRIGGER drive_upload_publications_admit
BEFORE INSERT ON drive_upload_publications
WHEN NOT EXISTS (SELECT 1 FROM drive_upload_intents i JOIN drive_active_members m ON m.id = i.owner_id
  JOIN drive_upload_publication_attempts a ON a.intent_id = i.id
    AND a.object_key = i.object_key AND a.upload_id = i.upload_id
    AND a.version + 1 = i.version AND a.declared_size = i.declared_size
  WHERE i.id = NEW.intent_id AND i.owner_id = NEW.owner_id AND i.object_key = NEW.object_key
    AND i.state = 'completing' AND i.completion_acknowledged = 0 AND i.version = NEW.intent_version
    AND i.declared_size = NEW.size_bytes)
  OR EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = NEW.intent_id)
  OR EXISTS (SELECT 1 FROM drive_upload_publication_tombstones WHERE intent_id = NEW.intent_id)
BEGIN
  SELECT RAISE(ABORT, 'upload publication not admitted');
END;

-- Do not let INSERT OR REPLACE discard a receipt after the file is gone.
CREATE TRIGGER drive_upload_publications_no_replace BEFORE INSERT ON drive_upload_publications
WHEN EXISTS (SELECT 1 FROM drive_upload_publications
  WHERE intent_id = NEW.intent_id OR entry_id = NEW.entry_id OR object_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'duplicate upload publication'); END;
CREATE TRIGGER drive_upload_publications_no_update BEFORE UPDATE ON drive_upload_publications
BEGIN SELECT RAISE(ABORT, 'upload publications are immutable'); END;
CREATE TRIGGER drive_upload_publications_no_delete BEFORE DELETE ON drive_upload_publications
BEGIN SELECT RAISE(ABORT, 'upload publications are permanent'); END;

CREATE TRIGGER drive_upload_publications_cleanup_fence
BEFORE INSERT ON drive_upload_cleanup_claims
WHEN EXISTS (SELECT 1 FROM drive_upload_publications WHERE intent_id = NEW.intent_id)
BEGIN
  SELECT RAISE(ABORT, 'upload is published');
END;

-- A legacy journal acknowledgement must not settle a publication attempt.
CREATE TRIGGER drive_upload_publications_ack_fence
BEFORE UPDATE OF completion_acknowledged ON drive_upload_intents
WHEN OLD.completion_acknowledged = 0 AND NEW.completion_acknowledged = 1
  AND EXISTS (SELECT 1 FROM drive_upload_publication_attempts WHERE intent_id = OLD.id)
  AND NOT EXISTS (SELECT 1 FROM drive_upload_publications WHERE intent_id = OLD.id AND intent_version = OLD.version)
BEGIN SELECT RAISE(ABORT, 'upload attempt requires publication'); END;

-- The outer INSERT's conflict policy can override nested CHECK handling. Abort
-- explicitly on invalid entry metadata and a folder count that cannot advance.
CREATE TRIGGER drive_upload_publications_insert_entry
AFTER INSERT ON drive_upload_publications
BEGIN
  SELECT CASE WHEN length(NEW.entry_id) = 0 OR length(CAST(NEW.name AS BLOB)) NOT BETWEEN 1 AND 255
    OR length(trim(NEW.name, ' .')) = 0 OR instr(NEW.name, '/') != 0 OR instr(NEW.name, char(0)) != 0
    THEN RAISE(ABORT, 'invalid publication metadata') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM drive_folder_counts WHERE folder_id = NEW.parent_id
    AND item_count = 9007199254740991) THEN RAISE(ABORT, 'folder count overflow') END;
  INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
  VALUES (NEW.entry_id, NEW.owner_id, NEW.parent_id, NEW.name, 'file', NEW.object_key, NEW.size_bytes);
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'upload file not inserted') END;
  UPDATE drive_upload_intents SET state = 'acknowledged', completion_acknowledged = 1, version = version + 1
    WHERE id = NEW.intent_id AND owner_id = NEW.owner_id AND object_key = NEW.object_key
      AND state = 'completing' AND version = NEW.intent_version;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'upload publication is stale') END;
END;
