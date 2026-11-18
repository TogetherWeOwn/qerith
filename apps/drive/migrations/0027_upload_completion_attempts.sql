-- Record the intent-wide fence atomically with the completion claim. It is
-- not evidence of provider success or authorization to publish or delete data.
CREATE TABLE drive_upload_publication_attempts (
  intent_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_intent_reservations (intent_id),
  object_key TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  declared_size INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- Reject replacement even if the journal was reset after the first attempt.
CREATE TRIGGER drive_upload_publication_attempts_guard_insert
BEFORE INSERT ON drive_upload_publication_attempts
WHEN EXISTS (SELECT 1 FROM drive_upload_publication_attempts WHERE intent_id = NEW.intent_id)
  OR EXISTS (SELECT 1 FROM drive_upload_completion_operations o
    JOIN drive_upload_completion_dispatches d USING (operation_id) WHERE o.intent_id = NEW.intent_id)
BEGIN SELECT RAISE(ABORT, 'upload completion already attempted'); END;

CREATE TRIGGER drive_upload_publication_attempts_claim
AFTER INSERT ON drive_upload_publication_attempts
BEGIN
  -- The existing cleanup fence rejects this UPDATE if cleanup claimed first.
  UPDATE drive_upload_intents SET state = 'completing', version = version + 1
    WHERE id = NEW.intent_id AND object_key = NEW.object_key AND upload_id = NEW.upload_id
      AND state = 'allocated' AND completion_acknowledged = 0 AND version = NEW.version
      AND version < 9007199254740989 AND declared_size = NEW.declared_size
      AND EXISTS (SELECT 1 FROM drive_active_members WHERE id = drive_upload_intents.owner_id)
      AND NOT EXISTS (SELECT 1 FROM drive_upload_publication_tombstones WHERE intent_id = NEW.intent_id);
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'upload completion claim is stale') END;
END;

-- A journal reset does not establish that cleanup or another dispatch is safe.
CREATE TRIGGER drive_upload_publication_attempts_cleanup_fence
BEFORE INSERT ON drive_upload_cleanup_claims
WHEN EXISTS (SELECT 1 FROM drive_upload_publication_attempts WHERE intent_id = NEW.intent_id)
BEGIN SELECT RAISE(ABORT, 'upload completion may be in flight'); END;

CREATE TRIGGER drive_upload_publication_attempts_dispatch_fence
BEFORE INSERT ON drive_upload_completion_dispatches
WHEN EXISTS (SELECT 1 FROM drive_upload_completion_operations o
  JOIN drive_upload_publication_attempts a USING (intent_id) WHERE o.operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'upload completion already attempted'); END;

CREATE TRIGGER drive_upload_publication_attempts_no_update
BEFORE UPDATE ON drive_upload_publication_attempts
BEGIN SELECT RAISE(ABORT, 'upload completion attempts are immutable'); END;

CREATE TRIGGER drive_upload_publication_attempts_no_delete
BEFORE DELETE ON drive_upload_publication_attempts
BEGIN SELECT RAISE(ABORT, 'upload completion attempts are permanent'); END;
