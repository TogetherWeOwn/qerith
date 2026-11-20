-- Pending invite registrations get their binding only when fresh options are issued.
ALTER TABLE drive_bound_ceremonies ADD COLUMN principal_id TEXT;
ALTER TABLE drive_bound_ceremonies ADD COLUMN webauthn_user_handle TEXT;
