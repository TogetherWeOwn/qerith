-- Internal metadata only. Access must be enforced by the service on every query.
CREATE TABLE drive_entries (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  parent_id TEXT REFERENCES drive_entries(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255 AND instr(name, '/') = 0 AND instr(name, char(0)) = 0),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  object_key TEXT UNIQUE,
  size_bytes INTEGER,
  CHECK ((kind = 'folder' AND object_key IS NULL AND size_bytes IS NULL) OR
         (kind = 'file' AND object_key IS NOT NULL AND length(object_key) > 0
          AND typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 0 AND 9007199254740991))
);

CREATE UNIQUE INDEX drive_entries_sibling_name
  ON drive_entries(owner_id, COALESCE(parent_id, ''), name);

CREATE INDEX drive_entries_owner_parent
  ON drive_entries(owner_id, parent_id, name, id);

-- Counters are maintained in the same transaction as metadata mutations. The
-- limb limit fails writes closed long before SQLite integer arithmetic overflows.
CREATE TABLE drive_folder_counts (
  folder_id TEXT PRIMARY KEY REFERENCES drive_entries(id) ON DELETE CASCADE,
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE drive_owner_usage (
  owner_id TEXT PRIMARY KEY,
  high INTEGER NOT NULL CHECK (high BETWEEN 0 AND 9007199254740991),
  low INTEGER NOT NULL CHECK (low BETWEEN 0 AND 999999999)
);

CREATE TRIGGER drive_entries_count_insert AFTER INSERT ON drive_entries
BEGIN
  INSERT INTO drive_folder_counts(folder_id, item_count)
    SELECT NEW.id, 0 WHERE NEW.kind = 'folder';
  UPDATE drive_folder_counts SET item_count = item_count + 1 WHERE folder_id = NEW.parent_id;
  INSERT INTO drive_owner_usage(owner_id, high, low)
    SELECT NEW.owner_id, NEW.size_bytes / 1000000000, NEW.size_bytes % 1000000000
    WHERE NEW.kind = 'file'
    ON CONFLICT(owner_id) DO UPDATE SET
      high = high + excluded.high + (low + excluded.low) / 1000000000,
      low = (low + excluded.low) % 1000000000;
END;

CREATE TRIGGER drive_entries_count_delete AFTER DELETE ON drive_entries
BEGIN
  UPDATE drive_folder_counts SET item_count = item_count - 1 WHERE folder_id = OLD.parent_id;
  UPDATE drive_owner_usage SET
    high = high - OLD.size_bytes / 1000000000 - (low < OLD.size_bytes % 1000000000),
    low = (low - OLD.size_bytes % 1000000000 + 1000000000) % 1000000000
    WHERE owner_id = OLD.owner_id AND OLD.kind = 'file';
END;

CREATE TRIGGER drive_entries_count_move AFTER UPDATE OF parent_id ON drive_entries
WHEN NEW.parent_id IS NOT OLD.parent_id
BEGIN
  UPDATE drive_folder_counts SET item_count = item_count - 1 WHERE folder_id = OLD.parent_id;
  UPDATE drive_folder_counts SET item_count = item_count + 1 WHERE folder_id = NEW.parent_id;
END;

CREATE TRIGGER drive_entries_usage_resize AFTER UPDATE OF size_bytes ON drive_entries
WHEN NEW.kind = 'file' AND NEW.size_bytes IS NOT OLD.size_bytes
BEGIN
  UPDATE drive_owner_usage SET
    high = high - OLD.size_bytes / 1000000000 - (low < OLD.size_bytes % 1000000000),
    low = (low - OLD.size_bytes % 1000000000 + 1000000000) % 1000000000
    WHERE owner_id = OLD.owner_id;
  UPDATE drive_owner_usage SET
    high = high + NEW.size_bytes / 1000000000 + (low + NEW.size_bytes % 1000000000) / 1000000000,
    low = (low + NEW.size_bytes % 1000000000) % 1000000000
    WHERE owner_id = NEW.owner_id;
END;

CREATE TRIGGER drive_entries_insert_parent
BEFORE INSERT ON drive_entries WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM drive_entries WHERE id = NEW.parent_id
      AND owner_id = NEW.owner_id AND kind = 'folder'
  ) THEN RAISE(ABORT, 'invalid parent') END;
END;

CREATE TRIGGER drive_entries_immutable
BEFORE UPDATE OF id, owner_id, kind, object_key ON drive_entries
WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.kind IS NOT OLD.kind OR NEW.object_key IS NOT OLD.object_key
BEGIN
  SELECT RAISE(ABORT, 'immutable metadata');
END;

CREATE TRIGGER drive_entries_move_parent
BEFORE UPDATE OF parent_id ON drive_entries WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM drive_entries WHERE id = NEW.parent_id
      AND owner_id = NEW.owner_id AND kind = 'folder'
  ) THEN RAISE(ABORT, 'invalid parent') END;
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE ancestors(id, parent_id) AS (
      SELECT id, parent_id FROM drive_entries WHERE id = NEW.parent_id
      UNION
      SELECT e.id, e.parent_id FROM drive_entries e JOIN ancestors a ON e.id = a.parent_id
    ) SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN RAISE(ABORT, 'folder cycle') END;
END;
