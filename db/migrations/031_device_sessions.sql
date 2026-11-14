-- A push token belongs to the sign-in session it was registered under (the refresh-token family). Pushes only go to
-- devices whose session is still signed in, so signing out, an expired session or a suspension stops them even if
-- the app never got to remove its token. Rows from before this (session_family NULL) need any live session of the user.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS session_family UUID;
CREATE INDEX IF NOT EXISTS devices_session_family ON devices (session_family);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_live ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- Phones of accounts that aren't signed in anywhere any more: drop them now.
DELETE FROM devices d
 WHERE NOT EXISTS (SELECT 1 FROM refresh_tokens r WHERE r.user_id = d.user_id AND r.revoked_at IS NULL AND r.expires_at > now());
