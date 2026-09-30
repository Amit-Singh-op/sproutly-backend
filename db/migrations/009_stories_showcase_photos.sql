-- Show off posts can carry a photo (the companion snapshot stays, for the card's badge and older clients).
ALTER TABLE showcase_posts ADD COLUMN IF NOT EXISTS image_url TEXT;

-- 24-hour stories: a photo (optional caption) or a text card on a coloured background.
CREATE TABLE IF NOT EXISTS stories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'text')),
  image_url TEXT,
  text TEXT,
  bg TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  CHECK ((kind = 'image' AND image_url IS NOT NULL) OR (kind = 'text' AND text IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS stories_user_expiry ON stories (user_id, expires_at);

CREATE TABLE IF NOT EXISTS story_views (
  story_id UUID NOT NULL REFERENCES stories ON DELETE CASCADE,
  viewer_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id)
);
