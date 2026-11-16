-- Invitation issuance and cancellation only; enrollment is not implemented.
CREATE TABLE drive_invitations (
  id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at INTEGER NOT NULL,
  cancelled_at INTEGER
) WITHOUT ROWID;
