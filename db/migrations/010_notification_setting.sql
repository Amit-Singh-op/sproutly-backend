-- Master switch for push notifications (Settings). Off = no pushes to any of the user's devices.
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;
