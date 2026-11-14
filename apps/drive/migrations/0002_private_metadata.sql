-- Private entry metadata; identity integration is supplied separately.
CREATE TABLE drive_entries (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  owner_id TEXT NOT NULL CHECK (length(owner_id) > 0),
  parent_id TEXT REFERENCES drive_entries(id),
  name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 255 AND length(trim(name, ' .')) > 0
    AND instr(name, '/') = 0 AND instr(name, char(0)) = 0),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  object_key TEXT UNIQUE,
  size_bytes INTEGER,
  CHECK ((kind = 'folder' AND object_key IS NULL AND size_bytes IS NULL) OR
         (kind = 'file' AND object_key IS NOT NULL AND length(object_key) > 0
          AND typeof(size_bytes) = 'integer' AND size_bytes BETWEEN 0 AND 9007199254740991))
);

CREATE UNIQUE INDEX drive_entries_sibling_name
  ON drive_entries(owner_id, COALESCE(parent_id, ''), name);
CREATE INDEX drive_entries_owner_parent ON drive_entries(owner_id, parent_id);

-- Reject all insert conflicts before SQLite can replace an existing row.
CREATE TRIGGER drive_entries_insert_conflict
BEFORE INSERT ON drive_entries
WHEN EXISTS (
  SELECT 1 FROM drive_entries WHERE id = NEW.id
    OR (NEW.object_key IS NOT NULL AND object_key = NEW.object_key)
    OR (owner_id = NEW.owner_id AND COALESCE(parent_id, '') = COALESCE(NEW.parent_id, '') AND name = NEW.name)
)
BEGIN
  SELECT RAISE(ABORT, 'conflicting metadata');
END;

CREATE TRIGGER drive_entries_insert_parent
BEFORE INSERT ON drive_entries WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM drive_entries WHERE id = NEW.parent_id
      AND owner_id = NEW.owner_id AND kind = 'folder'
  ) THEN RAISE(ABORT, 'invalid parent') END;
END;

CREATE TRIGGER drive_entries_update_conflict
BEFORE UPDATE OF parent_id, name ON drive_entries
WHEN EXISTS (
  SELECT 1 FROM drive_entries WHERE id != OLD.id AND owner_id = NEW.owner_id
    AND COALESCE(parent_id, '') = COALESCE(NEW.parent_id, '') AND name = NEW.name
)
BEGIN
  SELECT RAISE(ABORT, 'conflicting metadata');
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
