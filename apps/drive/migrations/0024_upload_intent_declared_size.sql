-- Legacy intents have no reliable size declaration; leave them NULL.
ALTER TABLE drive_upload_intents ADD COLUMN declared_size INTEGER CHECK (
  declared_size IS NULL OR (typeof(declared_size) = 'integer' AND declared_size BETWEEN 0 AND 9007199254740991)
);

CREATE TRIGGER drive_upload_intents_declared_size_immutable
BEFORE UPDATE OF declared_size ON drive_upload_intents
WHEN NEW.declared_size IS NOT OLD.declared_size
BEGIN
  SELECT RAISE(ABORT, 'declared upload size is immutable');
END;
