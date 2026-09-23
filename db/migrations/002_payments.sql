-- Payment bookkeeping on top of 001 (doc section 5).
-- last_event_ms guards against RevenueCat delivering webhooks out of order: an older event never overwrites newer state.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS store TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS will_renew BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_issue_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_event_ms BIGINT NOT NULL DEFAULT 0;

-- Unread counting and history paging read from the newest end.
CREATE INDEX IF NOT EXISTS messages_conv_sender_seq ON messages (conversation_id, seq) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS showcase_posts_user_created ON showcase_posts (user_id, created_at DESC);
