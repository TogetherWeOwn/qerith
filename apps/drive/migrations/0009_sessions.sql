-- Sessions are internal bearer credentials; only their SHA-256 hashes are stored.
CREATE TABLE drive_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  principal_id TEXT NOT NULL REFERENCES drive_principals(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX drive_sessions_principal ON drive_sessions(principal_id);

-- Re-enabling membership must never resurrect a previously issued session.
CREATE TRIGGER drive_sessions_disable AFTER UPDATE OF status ON drive_principals
WHEN OLD.status = 'active' AND NEW.status != 'active'
BEGIN
  DELETE FROM drive_sessions WHERE principal_id = NEW.id;
END;
