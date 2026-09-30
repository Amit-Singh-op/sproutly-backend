-- Show off is about your day: each post can carry what you were doing.
ALTER TABLE showcase_posts ADD COLUMN IF NOT EXISTS activity TEXT
  CHECK (activity IN ('workout','study','food','outdoors','gaming','art','music','chill'));
