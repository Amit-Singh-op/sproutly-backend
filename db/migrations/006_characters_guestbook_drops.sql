-- Plus characters (palette also picks the species), room guestbooks and the daily drop.

-- Guard palette values now that drake / bolt exist.
ALTER TABLE companions ADD CONSTRAINT companions_palette_check CHECK (palette IN ('mo','pip','blu','drake','bolt'));

-- One note per visitor per room per local day (the visitor's day).
CREATE TABLE guestbook_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  day DATE NOT NULL,
  sticker TEXT NOT NULL CHECK (sticker IN ('wave','heart','flower','star')),
  note TEXT CHECK (char_length(note) <= 80),
  palette TEXT NOT NULL,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, author_id, day),
  CHECK (owner_id <> author_id)
);
CREATE INDEX guestbook_owner_idx ON guestbook_entries (owner_id, created_at DESC);

-- One claim per user per local day. track_day is the position on the 7-day track that this claim used.
CREATE TABLE daily_drops (
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  day DATE NOT NULL,
  track_day INT NOT NULL CHECK (track_day BETWEEN 1 AND 7),
  rarity TEXT NOT NULL CHECK (rarity IN ('common','rare','epic')),
  energy INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
