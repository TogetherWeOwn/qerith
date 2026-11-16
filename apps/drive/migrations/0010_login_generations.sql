-- Invalidates in-flight verified logins when membership is disabled, including
-- when the member is re-enabled before the login commits.
CREATE TABLE drive_login_generations (
  principal_id TEXT PRIMARY KEY NOT NULL REFERENCES drive_principals(id) ON DELETE CASCADE,
  generation TEXT NOT NULL CHECK (length(generation) = 64)
) WITHOUT ROWID;

INSERT INTO drive_login_generations (principal_id, generation)
  SELECT id, lower(hex(randomblob(32))) FROM drive_principals;

CREATE TRIGGER drive_login_generation_create AFTER INSERT ON drive_principals
BEGIN
  INSERT INTO drive_login_generations VALUES (NEW.id, lower(hex(randomblob(32))));
END;

CREATE TRIGGER drive_login_generation_status AFTER UPDATE OF status ON drive_principals
WHEN OLD.status != NEW.status
BEGIN
  UPDATE drive_login_generations SET generation = lower(hex(randomblob(32))) WHERE principal_id = NEW.id;
  -- Discoverable challenges are not bound to a principal; invalidate them all.
  DELETE FROM drive_bound_ceremonies WHERE purpose = 'authentication';
END;
