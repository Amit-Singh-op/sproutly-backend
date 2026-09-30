-- Show off posts have two kinds: a moment from your day ('day') or a Mo update ('mo'). Only day posts take comments.
ALTER TABLE showcase_posts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'day' CHECK (kind IN ('day', 'mo'));
-- Older posts didn't record their kind: a post with no photo and no activity was a Mo update.
UPDATE showcase_posts SET kind = 'mo' WHERE image_url IS NULL AND activity IS NULL;
ALTER TABLE showcase_posts ADD COLUMN IF NOT EXISTS comment_count INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS showcase_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES showcase_posts ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS showcase_comments_post_idx ON showcase_comments (post_id, created_at);

-- Comments can be reported like every other kind of user content.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('user', 'message', 'post', 'story', 'comment'));
