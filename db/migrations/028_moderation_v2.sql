-- Moderation v2: report reasons with severity, admin review, warnings, mutes, temporary suspensions, and no more
-- automatic bans (reports can at most put an account on a 24-hour hold until an admin looks).
--
-- users.suspended_until  NULL with suspended_at set = a permanent ban; a time = suspended until then (lifted by itself)
-- users.muted_until      until then the person can read but not send messages, posts, comments, stories or Plaza lines
-- users.warning          a message from the moderators shown once the next time the app opens (cleared when seen)
-- reports.category       what the reporter picked (drives severity); old apps send none = 'other'
-- reports.subject_id     whose content it is (filled from the snapshot), so the queue groups by person
-- reports.status         open / actioned / dismissed (dismissed reports lower the reporter's weight next time)
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS warning TEXT;

ALTER TABLE reports ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'other'
  CHECK (category IN ('child_safety', 'violence', 'harassment', 'hate', 'sexual', 'self_harm', 'spam', 'scam', 'impersonation', 'other'));
ALTER TABLE reports ADD COLUMN IF NOT EXISTS subject_id UUID;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
UPDATE reports SET status = 'open' WHERE status NOT IN ('open', 'actioned', 'dismissed');
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_status_check;
ALTER TABLE reports ADD CONSTRAINT reports_status_check CHECK (status IN ('open', 'actioned', 'dismissed'));
CREATE INDEX IF NOT EXISTS reports_open_subject ON reports (subject_id, created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS reports_reporter ON reports (reporter_id, status);

-- Reported comments are hidden (and can be restored), not deleted.
ALTER TABLE showcase_comments ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- Temporary bans: a banned email can come back once `until` has passed (NULL = never).
ALTER TABLE banned_logins ADD COLUMN IF NOT EXISTS until TIMESTAMPTZ;

ALTER TABLE moderation_events DROP CONSTRAINT IF EXISTS moderation_events_kind_check;
ALTER TABLE moderation_events ADD CONSTRAINT moderation_events_kind_check CHECK (kind IN (
  'report', 'suspend', 'auto_suspend', 'unsuspend', 'sign_in_blocked',
  'auto_hold', 'warn', 'mute', 'unmute', 'remove_content', 'restore_content', 'dismiss'
));
