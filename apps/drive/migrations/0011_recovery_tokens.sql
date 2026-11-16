-- Issuance and cancellation only; no recovery redemption is implemented.
CREATE TABLE drive_recovery_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL REFERENCES drive_principals(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  expires_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  redeemed_at INTEGER
) WITHOUT ROWID;

-- A revoked and restored principal must not regain an old recovery token.
CREATE TRIGGER drive_recovery_membership_change
AFTER UPDATE OF status ON drive_principals
WHEN OLD.status != NEW.status
BEGIN
  UPDATE drive_recovery_tokens
  SET cancelled_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE cancelled_at IS NULL AND redeemed_at IS NULL
    AND (principal_id = OLD.id OR OLD.role = 'owner');
END;
