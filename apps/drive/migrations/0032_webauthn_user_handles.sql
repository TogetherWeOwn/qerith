-- A discoverable credential must be registered with its principal's handle.
-- Leave existing rows unbound; assertion responses do not establish a binding.
ALTER TABLE drive_principals ADD COLUMN webauthn_user_handle TEXT;
ALTER TABLE drive_credentials ADD COLUMN webauthn_user_handle TEXT;

CREATE UNIQUE INDEX drive_principal_webauthn_user_handle
  ON drive_principals(webauthn_user_handle)
  WHERE webauthn_user_handle IS NOT NULL;
