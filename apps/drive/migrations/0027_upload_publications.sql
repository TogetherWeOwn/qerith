-- A permanent dispatch fence is recorded atomically with the completion claim.
CREATE TABLE drive_upload_publication_attempts (
  intent_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_intents(id),
  object_key TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  declared_size INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER drive_upload_publication_attempts_claim
AFTER INSERT ON drive_upload_publication_attempts
BEGIN
  UPDATE drive_upload_intents SET state = 'completing', version = version + 1
    WHERE id = NEW.intent_id AND object_key = NEW.object_key AND upload_id = NEW.upload_id
      AND state = 'allocated' AND version = NEW.version AND declared_size = NEW.declared_size;
  SELECT CASE WHEN changes() != 1 THEN RAISE(ABORT, 'upload completion claim is stale') END;
END;

CREATE TRIGGER drive_upload_publication_attempts_cleanup_fence
BEFORE INSERT ON drive_upload_cleanup_claims
WHEN EXISTS (SELECT 1 FROM drive_upload_publication_attempts WHERE intent_id = NEW.intent_id)
BEGIN SELECT RAISE(ABORT, 'upload completion may be in flight'); END;

CREATE TRIGGER drive_upload_publication_attempts_dispatch_fence
BEFORE INSERT ON drive_upload_completion_dispatches
WHEN EXISTS (SELECT 1 FROM drive_upload_completion_operations o
  JOIN drive_upload_publication_attempts a ON a.intent_id = o.intent_id
  WHERE o.operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'upload completion already attempted'); END;

CREATE TRIGGER drive_upload_publication_attempts_no_update
BEFORE UPDATE ON drive_upload_publication_attempts
BEGIN SELECT RAISE(ABORT, 'upload completion attempts are immutable'); END;

CREATE TRIGGER drive_upload_publication_attempts_no_delete
BEFORE DELETE ON drive_upload_publication_attempts
BEGIN SELECT RAISE(ABORT, 'upload completion attempts are permanent'); END;
