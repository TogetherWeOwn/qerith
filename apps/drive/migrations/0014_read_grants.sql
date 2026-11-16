-- Explicit grants apply to exactly one entry, never to descendants.
CREATE TABLE drive_read_grants (
  entry_id TEXT NOT NULL REFERENCES drive_entries(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES drive_principals(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, recipient_id)
) WITHOUT ROWID;

CREATE INDEX drive_read_grants_recipient ON drive_read_grants(recipient_id);

-- Re-enabling either party must not restore a previously issued grant.
CREATE TRIGGER drive_read_grants_disable AFTER UPDATE OF status ON drive_principals
WHEN OLD.status = 'active' AND NEW.status != 'active'
BEGIN
  DELETE FROM drive_read_grants WHERE recipient_id = NEW.id OR entry_id IN (
    SELECT id FROM drive_entries WHERE owner_id = NEW.id
  );
END;
