-- Permanent intent-wide exclusion, not authorization to delete provider data.
-- Publication tombstones (0022) still gate sealed completion but do not replace this claim.
CREATE TABLE drive_upload_cleanup_claims (
  intent_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_upload_intent_reservations (intent_id)
) STRICT, WITHOUT ROWID;

-- A dispatch remains a fence even if its receipt is missing, present or quarantined.
-- Legacy claims may have no dispatch row, so also exclude in-flight/uncertain intents.
CREATE TRIGGER drive_upload_cleanup_claims_admit
BEFORE INSERT ON drive_upload_cleanup_claims
WHEN EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = NEW.intent_id)
  OR NOT EXISTS (SELECT 1 FROM drive_upload_intents i JOIN drive_upload_intent_reservations r
    ON r.intent_id = i.id AND r.owner_id = i.owner_id AND r.object_key = i.object_key
    WHERE i.id = NEW.intent_id AND i.state IN ('created', 'allocated', 'acknowledged'))
  OR EXISTS (SELECT 1 FROM drive_upload_completion_operations o
    JOIN drive_upload_completion_dispatches d USING (operation_id) WHERE o.intent_id = NEW.intent_id)
BEGIN SELECT RAISE(ABORT, 'upload cleanup not admitted'); END;

CREATE TRIGGER drive_upload_dispatch_cleanup_fence
BEFORE INSERT ON drive_upload_completion_dispatches
WHEN EXISTS (SELECT 1 FROM drive_upload_completion_operations o
  JOIN drive_upload_cleanup_claims c USING (intent_id) WHERE o.operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'upload cleanup already claimed'); END;

CREATE TRIGGER drive_upload_intents_cleanup_fence
BEFORE UPDATE OF state ON drive_upload_intents
WHEN NEW.state IN ('initiating', 'completing')
  AND EXISTS (SELECT 1 FROM drive_upload_cleanup_claims WHERE intent_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'upload cleanup already claimed'); END;

CREATE TRIGGER drive_upload_cleanup_claims_no_update
BEFORE UPDATE ON drive_upload_cleanup_claims
BEGIN SELECT RAISE(ABORT, 'upload cleanup claims are immutable'); END;

CREATE TRIGGER drive_upload_cleanup_claims_no_delete
BEFORE DELETE ON drive_upload_cleanup_claims
BEGIN SELECT RAISE(ABORT, 'upload cleanup claims are permanent'); END;
