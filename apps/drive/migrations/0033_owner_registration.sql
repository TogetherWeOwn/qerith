-- One pending deployer ceremony, separate from invitation and recovery state.
CREATE TABLE drive_owner_registration (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  challenge TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  webauthn_user_handle TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
