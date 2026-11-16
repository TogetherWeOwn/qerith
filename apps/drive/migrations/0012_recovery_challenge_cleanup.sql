-- Clear already-invalidated recovery ceremonies from the reserved namespace.
DELETE FROM drive_bound_ceremonies
WHERE purpose = 'registration' AND length(context) = 73 AND substr(context, 1, 9) = 'recovery:'
  AND NOT EXISTS (SELECT 1 FROM drive_recovery_tokens t JOIN drive_principals p ON p.id = t.principal_id
    WHERE t.token_hash = substr(context, 10) AND t.cancelled_at IS NULL AND t.redeemed_at IS NULL
      AND t.expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER) AND p.status = 'active');

-- Invalidating a recovery token releases its reserved ceremony slot atomically.
CREATE TRIGGER drive_recovery_challenge_invalidate
AFTER UPDATE OF cancelled_at, redeemed_at ON drive_recovery_tokens
WHEN NEW.cancelled_at IS NOT NULL OR NEW.redeemed_at IS NOT NULL
BEGIN
  DELETE FROM drive_bound_ceremonies
  WHERE context = 'recovery:' || NEW.token_hash AND purpose = 'registration';
END;

CREATE TRIGGER drive_recovery_challenge_delete
AFTER DELETE ON drive_recovery_tokens
BEGIN
  DELETE FROM drive_bound_ceremonies
  WHERE context = 'recovery:' || OLD.token_hash AND purpose = 'registration';
END;
