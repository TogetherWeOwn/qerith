-- Upload intents are reconciliation evidence, not visible file entries.
CREATE TABLE drive_upload_intents (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  upload_id TEXT,
  completion_acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (completion_acknowledged IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('created', 'initiating', 'allocated', 'completing', 'uncertain', 'acknowledged')),
  version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(version) = 'integer' AND version BETWEEN 0 AND 9007199254740991),
  CHECK (length(id) > 0 AND length(owner_id) > 0 AND length(object_key) > 0),
  CHECK (upload_id IS NULL OR length(upload_id) > 0),
  CHECK (state NOT IN ('allocated', 'completing', 'acknowledged') OR upload_id IS NOT NULL)
) WITHOUT ROWID;
