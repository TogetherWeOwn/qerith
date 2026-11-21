-- Invitation display metadata is not an account name. Leave retained rows unnamed.
ALTER TABLE drive_principals ADD COLUMN display_name TEXT;
