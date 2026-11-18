-- The cleanup primitive scans only the oldest expiry-indexed sessions.
CREATE INDEX drive_sessions_expiry ON drive_sessions(expires_at, token_hash);
