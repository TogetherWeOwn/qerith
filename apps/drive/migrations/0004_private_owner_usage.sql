-- D1 applies this migration and its ledger entry atomically. Usage uses base 10^9
-- limbs so neither JavaScript nor SQLite has to represent the full byte total.
CREATE TABLE drive_owner_usage (
  owner_id TEXT PRIMARY KEY NOT NULL,
  high INTEGER NOT NULL CHECK (typeof(high) = 'integer' AND high BETWEEN 0 AND 9007199254740991),
  low INTEGER NOT NULL CHECK (typeof(low) = 'integer' AND low BETWEEN 0 AND 999999999)
) WITHOUT ROWID;

-- Feed existing file rows through the same bounded addition, without SUM.
CREATE TABLE drive_usage_backfill (owner_id TEXT NOT NULL, size_bytes INTEGER NOT NULL);
CREATE TRIGGER drive_usage_backfill_insert AFTER INSERT ON drive_usage_backfill
BEGIN
  INSERT INTO drive_owner_usage VALUES (NEW.owner_id, NEW.size_bytes / 1000000000, NEW.size_bytes % 1000000000)
    ON CONFLICT(owner_id) DO UPDATE SET
      high = high + excluded.high + (low + excluded.low) / 1000000000,
      low = (low + excluded.low) % 1000000000;
END;
INSERT INTO drive_usage_backfill SELECT owner_id, size_bytes FROM drive_entries WHERE kind = 'file';
DROP TABLE drive_usage_backfill;

CREATE TRIGGER drive_usage_insert AFTER INSERT ON drive_entries WHEN NEW.kind = 'file'
BEGIN
  INSERT INTO drive_owner_usage VALUES (NEW.owner_id, NEW.size_bytes / 1000000000, NEW.size_bytes % 1000000000)
    ON CONFLICT(owner_id) DO UPDATE SET
      high = high + excluded.high + (low + excluded.low) / 1000000000,
      low = (low + excluded.low) % 1000000000;
END;

CREATE TRIGGER drive_usage_delete AFTER DELETE ON drive_entries WHEN OLD.kind = 'file'
BEGIN
  UPDATE drive_owner_usage SET
    high = high - OLD.size_bytes / 1000000000 - (low < OLD.size_bytes % 1000000000),
    low = (low - OLD.size_bytes % 1000000000 + 1000000000) % 1000000000
    WHERE owner_id = OLD.owner_id;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'missing owner usage') END;
END;

CREATE TRIGGER drive_usage_resize AFTER UPDATE OF size_bytes ON drive_entries
WHEN NEW.kind = 'file' AND NEW.size_bytes IS NOT OLD.size_bytes
BEGIN
  UPDATE drive_owner_usage SET
    high = high - OLD.size_bytes / 1000000000 - (low < OLD.size_bytes % 1000000000),
    low = (low - OLD.size_bytes % 1000000000 + 1000000000) % 1000000000
    WHERE owner_id = OLD.owner_id;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'missing owner usage') END;
  UPDATE drive_owner_usage SET
    high = high + NEW.size_bytes / 1000000000 + (low + NEW.size_bytes % 1000000000) / 1000000000,
    low = (low + NEW.size_bytes % 1000000000) % 1000000000
    WHERE owner_id = NEW.owner_id;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'owner usage overflow or missing') END;
END;
