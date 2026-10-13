-- Safety: evidence that survives deletion (for moderators only), guestbook reports, device bans, automatic flags.
--
-- deleted_messages  a private copy of a chat message when its sender deletes it (or deletes their account), kept
--                   DELETED_KEEP_DAYS so a later report can still be checked. Only moderators can see it, and only
--                   on an account under review. Purged by the daily cleanup job.
-- user_devices      which app installs an account used (a random per-install id), so a ban can cover the device too.
-- banned_devices    installs that may not sign in or create accounts (set when an account is banned for good).
CREATE TABLE IF NOT EXISTS deleted_messages (
  message_id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL,
  sender_id UUID,
  type TEXT NOT NULL,
  body TEXT,
  payload JSONB,
  sent_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '14 days'
);
CREATE INDEX IF NOT EXISTS deleted_messages_sender ON deleted_messages (sender_id, deleted_at DESC);
CREATE INDEX IF NOT EXISTS deleted_messages_expiry ON deleted_messages (expires_at);

CREATE TABLE IF NOT EXISTS user_devices (
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS user_devices_device ON user_devices (device_id);

CREATE TABLE IF NOT EXISTS banned_devices (
  device_id TEXT PRIMARY KEY,
  user_id UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('user', 'message', 'post', 'story', 'comment', 'guestbook'));

ALTER TABLE moderation_events DROP CONSTRAINT IF EXISTS moderation_events_kind_check;
ALTER TABLE moderation_events ADD CONSTRAINT moderation_events_kind_check CHECK (kind IN (
  'report', 'suspend', 'auto_suspend', 'unsuspend', 'sign_in_blocked',
  'auto_hold', 'warn', 'mute', 'unmute', 'remove_content', 'restore_content', 'dismiss',
  'auto_flag', 'device_blocked'
));
