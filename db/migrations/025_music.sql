-- "Your song": a song link from a music app on your profile, shown as a card (title, artist, cover) to your friends,
-- on your profile and in their friends list. song = {url, title, artist, artUrl, provider} or NULL.
CREATE TABLE IF NOT EXISTS user_music (
  user_id UUID PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  song JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
