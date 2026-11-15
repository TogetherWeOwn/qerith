-- Membership only; enrollment and authentication are separate services.
CREATE TABLE drive_principals (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked'))
) WITHOUT ROWID;

CREATE UNIQUE INDEX drive_single_owner ON drive_principals(role) WHERE role = 'owner';

CREATE VIEW drive_active_members AS
  SELECT id FROM drive_principals WHERE status = 'active';
