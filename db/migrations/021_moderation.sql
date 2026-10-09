-- Moderation records.
--
-- moderation_events: everything that happened around a person's account, kept so it's easy to see what they did:
-- reports against them (with a snapshot of the reported content, because messages expire after 3 days and reported
-- stories are deleted), suspensions (automatic or by an admin), lifted suspensions, and sign-in attempts while
-- suspended. Not tied to the users table by a foreign key, so the record outlives a deleted account.
CREATE TABLE IF NOT EXISTS moderation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id UUID,
  subject_login TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('report', 'suspend', 'auto_suspend', 'unsuspend', 'sign_in_blocked')),
  -- 'system', 'admin', or the reporting user's id.
  actor TEXT NOT NULL,
  reason TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_events_subject ON moderation_events (subject_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_events_login ON moderation_events (subject_login, created_at DESC);

-- Emails that may not sign in or sign up again (a suspended person deleting their account can't come back with the
-- same email). Lifting a suspension removes the row.
CREATE TABLE IF NOT EXISTS banned_logins (
  login TEXT PRIMARY KEY,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
