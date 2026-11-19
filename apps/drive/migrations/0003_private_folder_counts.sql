-- Applied atomically with the migration ledger by D1; existing entries remain authoritative.
CREATE TABLE drive_folder_counts (
  folder_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_entries(id) ON DELETE CASCADE,
  item_count INTEGER NOT NULL CHECK (typeof(item_count) = 'integer' AND item_count BETWEEN 0 AND 9007199254740991)
) WITHOUT ROWID;

INSERT INTO drive_folder_counts (folder_id, item_count)
  SELECT f.id, (SELECT COUNT(*) FROM drive_entries AS e WHERE e.parent_id = f.id)
  FROM drive_entries AS f WHERE f.kind = 'folder';

CREATE TRIGGER drive_counts_insert AFTER INSERT ON drive_entries
BEGIN
  INSERT INTO drive_folder_counts SELECT NEW.id, 0 WHERE NEW.kind = 'folder';
  UPDATE drive_folder_counts SET item_count = item_count + 1 WHERE folder_id = NEW.parent_id;
  SELECT CASE WHEN NEW.parent_id IS NOT NULL AND changes() != 1 THEN RAISE(ABORT, 'missing folder count') END;
END;

CREATE TRIGGER drive_counts_move AFTER UPDATE OF parent_id ON drive_entries
WHEN NEW.parent_id IS NOT OLD.parent_id
BEGIN
  UPDATE drive_folder_counts SET item_count = item_count - 1 WHERE folder_id = OLD.parent_id;
  SELECT CASE WHEN OLD.parent_id IS NOT NULL AND changes() != 1 THEN RAISE(ABORT, 'missing folder count') END;
  UPDATE drive_folder_counts SET item_count = item_count + 1 WHERE folder_id = NEW.parent_id;
  SELECT CASE WHEN NEW.parent_id IS NOT NULL AND changes() != 1 THEN RAISE(ABORT, 'missing folder count') END;
END;

CREATE TRIGGER drive_counts_delete AFTER DELETE ON drive_entries
BEGIN
  UPDATE drive_folder_counts SET item_count = item_count - 1 WHERE folder_id = OLD.parent_id;
  SELECT CASE WHEN OLD.parent_id IS NOT NULL AND changes() != 1 THEN RAISE(ABORT, 'missing folder count') END;
END;
