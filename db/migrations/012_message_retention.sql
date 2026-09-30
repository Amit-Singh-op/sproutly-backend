-- Messages are kept for 3 days (hourly purge + every read filters by age); this makes both cheap.
CREATE INDEX IF NOT EXISTS messages_created_at ON messages (created_at);
CREATE INDEX IF NOT EXISTS stories_expires_at ON stories (expires_at);
