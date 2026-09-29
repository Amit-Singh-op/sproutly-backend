-- Profile photos (Cloudinary URLs) and the Plus avatar-stage style picks, which were accepted but never stored.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

ALTER TABLE chat_styles ADD COLUMN IF NOT EXISTS avatar_animation TEXT
  CHECK (avatar_animation IN ('float','bounce','spin','glide','zen'));
ALTER TABLE chat_styles ADD COLUMN IF NOT EXISTS avatar_effect TEXT
  CHECK (avatar_effect IN ('fire','water','sparkle','nature','lightning','hearts'));
ALTER TABLE chat_styles ADD COLUMN IF NOT EXISTS avatar_charm TEXT
  CHECK (avatar_charm IN ('crown','star','diamond','flame','lightning','sparkle'));
