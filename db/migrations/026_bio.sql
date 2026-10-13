-- A short bio on your profile (up to 160 characters), shown to anyone who can open your profile.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT CHECK (bio IS NULL OR char_length(bio) <= 160);
