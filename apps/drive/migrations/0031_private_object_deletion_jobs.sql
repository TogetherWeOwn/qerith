CREATE TABLE drive_object_deletion_jobs (
  entry_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_deleted_entries(entry_id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  available_at INTEGER NOT NULL DEFAULT (unixepoch()),
  lease_token TEXT,
  completed_at INTEGER
) STRICT, WITHOUT ROWID;
CREATE INDEX drive_object_deletion_jobs_due ON drive_object_deletion_jobs (available_at, entry_id)
  WHERE completed_at IS NULL;

-- No backfill: enqueue only as part of the transaction removing the exact
-- authorized entry. Legacy and unresolved uploads keep their tombstones only.
CREATE TRIGGER drive_private_object_deletion_enqueue AFTER DELETE ON drive_entries
WHEN OLD.kind = 'file' AND EXISTS (SELECT 1 FROM drive_deleted_entries t
  WHERE t.entry_id = OLD.id AND t.owner_id = OLD.owner_id AND t.object_key = OLD.object_key)
BEGIN
  INSERT INTO drive_upload_publication_tombstones (intent_id)
    SELECT intent_id FROM drive_published_generations
    WHERE entry_id = OLD.id AND owner_id = OLD.owner_id AND object_key = OLD.object_key
    ON CONFLICT (intent_id) DO NOTHING;
  INSERT INTO drive_object_deletion_jobs (entry_id)
    SELECT entry_id FROM drive_published_generations
    WHERE entry_id = OLD.id AND owner_id = OLD.owner_id AND object_key = OLD.object_key;
END;

CREATE TRIGGER drive_object_deletion_jobs_no_replace BEFORE INSERT ON drive_object_deletion_jobs
WHEN EXISTS (SELECT 1 FROM drive_object_deletion_jobs WHERE entry_id = NEW.entry_id)
BEGIN SELECT RAISE(ABORT, 'duplicate object deletion job'); END;
CREATE TRIGGER drive_object_deletion_jobs_preserve_receipt BEFORE UPDATE ON drive_object_deletion_jobs
WHEN NEW.entry_id IS NOT OLD.entry_id OR NEW.created_at IS NOT OLD.created_at OR OLD.completed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'object deletion receipt is immutable'); END;
CREATE TRIGGER drive_object_deletion_jobs_no_delete BEFORE DELETE ON drive_object_deletion_jobs
BEGIN SELECT RAISE(ABORT, 'object deletion jobs are permanent'); END;
