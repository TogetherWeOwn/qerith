-- Permanent metadata deletion evidence. An object key alone does not identify a
-- storage target or authorize provider cleanup.
CREATE TABLE drive_deleted_entries (
  entry_id TEXT PRIMARY KEY NOT NULL,
  deletion_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  object_key TEXT UNIQUE
) STRICT, WITHOUT ROWID;
CREATE INDEX drive_deleted_entries_operation ON drive_deleted_entries(deletion_id);

CREATE TRIGGER drive_deleted_entries_no_replace BEFORE INSERT ON drive_deleted_entries
WHEN EXISTS (SELECT 1 FROM drive_deleted_entries WHERE entry_id = NEW.entry_id OR object_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'deletion already recorded'); END;
CREATE TRIGGER drive_deleted_entries_no_update BEFORE UPDATE ON drive_deleted_entries
BEGIN SELECT RAISE(ABORT, 'deletion evidence is immutable'); END;
CREATE TRIGGER drive_deleted_entries_no_delete BEFORE DELETE ON drive_deleted_entries
BEGIN SELECT RAISE(ABORT, 'deletion evidence is permanent'); END;

CREATE TRIGGER drive_entries_no_deleted_identity BEFORE INSERT ON drive_entries
WHEN EXISTS (SELECT 1 FROM drive_deleted_entries WHERE entry_id = NEW.id OR object_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'deleted entry identity'); END;
CREATE TRIGGER drive_upload_intents_no_deleted_key BEFORE INSERT ON drive_upload_intents
WHEN EXISTS (SELECT 1 FROM drive_deleted_entries WHERE object_key = NEW.object_key)
BEGIN SELECT RAISE(ABORT, 'deleted object key'); END;

-- The self-referencing foreign key probes parent_id without owner_id.
CREATE INDEX drive_entries_parent_fk ON drive_entries(parent_id);

-- Recursive deletes are one statement. A parent's counts may have already
-- cascaded away; a surviving parent must still have its count decremented.
DROP TRIGGER drive_counts_delete;
CREATE TRIGGER drive_counts_delete AFTER DELETE ON drive_entries
WHEN EXISTS (SELECT 1 FROM drive_entries WHERE id = OLD.parent_id)
BEGIN
  UPDATE drive_folder_counts SET item_count = item_count - 1 WHERE folder_id = OLD.parent_id;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'missing folder count') END;
END;
