-- Urgent reports (child safety, threats, self-harm) still open after 30 minutes re-alert moderators every 2 hours
-- until someone reviews them; reminded_at is when the last reminder went out.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS reports_open_urgent ON reports (created_at) WHERE status = 'open' AND category IN ('child_safety', 'violence', 'self_harm');
