-- A publication is retained even if its visible entry is later removed.
CREATE TABLE drive_upload_publications (
  intent_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_intents(id),
  intent_version INTEGER NOT NULL,
  entry_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  parent_id TEXT,
  name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  object_etag TEXT NOT NULL CHECK (length(object_etag) > 0)
) WITHOUT ROWID;

-- A published object must not be admitted for provider cleanup, including
-- after the visible entry has been removed.
CREATE TRIGGER drive_upload_publications_cleanup_fence
BEFORE INSERT ON drive_upload_cleanup_claims
WHEN EXISTS (SELECT 1 FROM drive_upload_publications WHERE intent_id = NEW.intent_id)
BEGIN
  SELECT RAISE(ABORT, 'upload is published');
END;

CREATE TRIGGER drive_upload_publications_admit
BEFORE INSERT ON drive_upload_publications
WHEN NOT EXISTS (SELECT 1 FROM drive_upload_intents i JOIN drive_active_members m ON m.id = i.owner_id
  WHERE i.id = NEW.intent_id AND i.owner_id = NEW.owner_id AND i.object_key = NEW.object_key
    AND i.state = 'completing' AND i.version = NEW.intent_version
    AND i.declared_size IS NOT NULL AND i.declared_size = NEW.size_bytes)
  OR EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = NEW.intent_id)
  OR EXISTS (SELECT 1 FROM drive_upload_publication_tombstones WHERE intent_id = NEW.intent_id)
BEGIN
  SELECT RAISE(ABORT, 'upload publication not admitted');
END;

-- The journal evidence, publication receipt, entry and accounting triggers commit
-- or roll back together. The receipt is never an authorization for object cleanup.
CREATE TRIGGER drive_upload_publications_insert_entry
AFTER INSERT ON drive_upload_publications
BEGIN
  INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
  VALUES (NEW.entry_id, NEW.owner_id, NEW.parent_id, NEW.name, 'file', NEW.object_key, NEW.size_bytes);
  UPDATE drive_upload_intents SET state = 'acknowledged', completion_acknowledged = 1, version = version + 1
    WHERE id = NEW.intent_id AND owner_id = NEW.owner_id AND object_key = NEW.object_key
      AND state = 'completing' AND version = NEW.intent_version;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'upload publication is stale') END;
END;
