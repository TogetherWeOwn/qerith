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

-- The journal evidence, publication receipt, entry and accounting triggers commit
-- or roll back together. The receipt is never an authorization for object cleanup.
CREATE TRIGGER drive_upload_publications_insert_entry
AFTER INSERT ON drive_upload_publications
BEGIN
  INSERT INTO drive_entries (id, owner_id, parent_id, name, kind, object_key, size_bytes)
  VALUES (NEW.entry_id, NEW.owner_id, NEW.parent_id, NEW.name, 'file', NEW.object_key, NEW.size_bytes);
END;
