-- Existing invitations have no recorded creation time or display metadata.
ALTER TABLE drive_invitations ADD COLUMN display_name TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 64);
ALTER TABLE drive_invitations ADD COLUMN note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 140);
ALTER TABLE drive_invitations ADD COLUMN created_at INTEGER;
