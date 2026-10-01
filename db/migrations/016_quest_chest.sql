-- Daily quest chest: opened at most once per user per local day, after every quest that day is done.
CREATE TABLE IF NOT EXISTS quest_chests (
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  day DATE NOT NULL,
  coins INT NOT NULL,
  energy INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
