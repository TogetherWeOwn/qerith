CREATE TABLE drive_storage_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision TEXT NOT NULL CHECK (length(revision) = 36),
  storage_epoch TEXT NOT NULL CHECK (length(storage_epoch) = 36),
  nonce TEXT NOT NULL CHECK (length(nonce) = 24),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 32 AND 8192)
) STRICT;

CREATE TABLE drive_storage_probe (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  lease TEXT NOT NULL CHECK (length(lease) = 36),
  expires_at INTEGER NOT NULL
) STRICT;
