-- Unregistered K2 schema; not installed by Wrangler or any deployed writer.
CREATE TABLE drive_k2_metadata (
  entry_id TEXT PRIMARY KEY REFERENCES drive_entries(id) ON DELETE CASCADE,
  display_type TEXT NOT NULL CHECK (length(display_type) BETWEEN 1 AND 80),
  type_source TEXT NOT NULL CHECK (type_source = 'drive-write' OR
    (type_source = 'entry-kind' AND display_type IN ('File', 'Folder'))),
  modified_at_ms INTEGER,
  modified_source TEXT,
  -- Only a matching pinned publication attests legacy logical length.
  verified_size_bytes INTEGER CHECK (verified_size_bytes BETWEEN 0 AND 9007199254740991),
  CHECK ((modified_at_ms IS NULL AND modified_source IS NULL) OR
    (modified_at_ms IS NOT NULL AND modified_at_ms BETWEEN 0 AND 8640000000000000
      AND modified_source IS 'drive-write'))
) STRICT, WITHOUT ROWID;
