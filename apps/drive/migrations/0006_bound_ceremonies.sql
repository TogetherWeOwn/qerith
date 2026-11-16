CREATE TABLE drive_bound_ceremonies (
  context TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
  challenge TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (context, purpose)
) WITHOUT ROWID;
