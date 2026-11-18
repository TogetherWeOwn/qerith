-- Keys remain reserved even after their upload journal rows are removed.
-- Existing rows have no trustworthy storage configuration identity, so reserve globally.
CREATE TABLE drive_upload_key_reservations (
  object_key TEXT PRIMARY KEY NOT NULL CHECK (length(object_key) > 0)
) WITHOUT ROWID;

INSERT INTO drive_upload_key_reservations (object_key)
SELECT object_key FROM drive_upload_intents;

CREATE TRIGGER drive_upload_reservations_no_replace
BEFORE INSERT ON drive_upload_key_reservations
WHEN EXISTS (SELECT 1 FROM drive_upload_key_reservations WHERE object_key = NEW.object_key)
BEGIN
  SELECT RAISE(ABORT, 'upload key already reserved');
END;

CREATE TRIGGER drive_upload_reservations_no_update
BEFORE UPDATE ON drive_upload_key_reservations
BEGIN
  SELECT RAISE(ABORT, 'upload key reservations are immutable');
END;

CREATE TRIGGER drive_upload_reservations_no_delete
BEFORE DELETE ON drive_upload_key_reservations
BEGIN
  SELECT RAISE(ABORT, 'upload key reservations are permanent');
END;

CREATE TRIGGER drive_upload_intents_no_reuse
BEFORE INSERT ON drive_upload_intents
WHEN EXISTS (SELECT 1 FROM drive_upload_key_reservations WHERE object_key = NEW.object_key)
  OR EXISTS (SELECT 1 FROM drive_upload_intents WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'upload identity already used');
END;

CREATE TRIGGER drive_upload_intents_reserve_key
AFTER INSERT ON drive_upload_intents
BEGIN
  INSERT INTO drive_upload_key_reservations (object_key) VALUES (NEW.object_key);
END;

CREATE TRIGGER drive_upload_intents_identity_immutable
BEFORE UPDATE OF id, owner_id, object_key ON drive_upload_intents
WHEN NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.object_key IS NOT OLD.object_key
BEGIN
  SELECT RAISE(ABORT, 'upload identity is immutable');
END;
