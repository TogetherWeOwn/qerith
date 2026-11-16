-- Storage only. Enrollment must verify the ceremony and commit all changes atomically.
ALTER TABLE drive_invitations ADD COLUMN redeemed_at INTEGER;

CREATE TABLE drive_credentials (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  principal_id TEXT NOT NULL REFERENCES drive_principals(id),
  public_key BLOB NOT NULL CHECK (length(public_key) > 0),
  counter INTEGER NOT NULL CHECK (counter >= 0),
  transports TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX drive_credentials_principal ON drive_credentials(principal_id);
