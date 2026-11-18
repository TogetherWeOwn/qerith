-- Reserve surviving journal identities, not historical operation evidence.
-- The key ledger alone cannot recover IDs of intents deleted before this migration.
CREATE TABLE drive_upload_intent_reservations (
  intent_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE REFERENCES drive_upload_key_reservations (object_key)
) WITHOUT ROWID;

INSERT INTO drive_upload_intent_reservations (intent_id, owner_id, object_key)
SELECT id, owner_id, object_key FROM drive_upload_intents;

CREATE TRIGGER drive_upload_intent_reservations_guard_insert
BEFORE INSERT ON drive_upload_intent_reservations
WHEN EXISTS (SELECT 1 FROM drive_upload_intent_reservations
  WHERE intent_id = NEW.intent_id OR object_key = NEW.object_key)
  OR NOT EXISTS (SELECT 1 FROM drive_upload_intents
    WHERE id = NEW.intent_id AND owner_id = NEW.owner_id AND object_key = NEW.object_key)
BEGIN
  SELECT RAISE(ABORT, 'cannot reserve upload intent identity');
END;

CREATE TRIGGER drive_upload_intent_reservations_no_update
BEFORE UPDATE ON drive_upload_intent_reservations
BEGIN
  SELECT RAISE(ABORT, 'upload intent reservations are immutable');
END;

CREATE TRIGGER drive_upload_intent_reservations_no_delete
BEFORE DELETE ON drive_upload_intent_reservations
BEGIN
  SELECT RAISE(ABORT, 'upload intent reservations are permanent');
END;

CREATE TRIGGER drive_upload_intents_no_reserved_id
BEFORE INSERT ON drive_upload_intents
WHEN EXISTS (SELECT 1 FROM drive_upload_intent_reservations WHERE intent_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'upload intent ID already reserved');
END;

-- A single trigger orders both reservations and commits them with the journal insert.
DROP TRIGGER drive_upload_intents_reserve_key;
CREATE TRIGGER drive_upload_intents_reserve_identity
AFTER INSERT ON drive_upload_intents
BEGIN
  INSERT INTO drive_upload_key_reservations (object_key) VALUES (NEW.object_key);
  INSERT INTO drive_upload_intent_reservations (intent_id, owner_id, object_key)
    VALUES (NEW.id, NEW.owner_id, NEW.object_key);
END;
