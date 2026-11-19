-- Retain consumed and expired challenges as tombstones to prevent re-issuance.
CREATE TABLE drive_webauthn_challenges (
  challenge TEXT PRIMARY KEY NOT NULL CHECK (length(challenge) > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > 0),
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1))
) WITHOUT ROWID;
