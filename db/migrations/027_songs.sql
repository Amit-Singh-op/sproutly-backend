-- Your songs: up to 5 song cards on your profile (newest first) instead of one. Any song already set is kept.
ALTER TABLE user_music ADD COLUMN IF NOT EXISTS songs JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE user_music SET songs = jsonb_build_array(song) WHERE song IS NOT NULL AND songs = '[]'::jsonb;
ALTER TABLE user_music DROP COLUMN IF EXISTS song;
