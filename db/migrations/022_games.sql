-- Minigames: every run (started and finished on the server, so its length is measured here, not by the phone) and
-- each player's best score per game, per week ('2026-W41') and all time ('all').
CREATE TABLE IF NOT EXISTS game_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  game TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  score INTEGER,
  coins INTEGER NOT NULL DEFAULT 0,
  -- TRUE when the score was impossible for the time played (not counted; kept for review).
  flagged BOOLEAN NOT NULL DEFAULT FALSE,
  local_day TEXT
);
CREATE INDEX IF NOT EXISTS game_sessions_user_day ON game_sessions (user_id, local_day);
CREATE INDEX IF NOT EXISTS game_sessions_open ON game_sessions (user_id, started_at) WHERE finished_at IS NULL;

CREATE TABLE IF NOT EXISTS game_bests (
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  game TEXT NOT NULL,
  period TEXT NOT NULL,
  score INTEGER NOT NULL,
  achieved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game, period)
);
-- Leaderboard: highest score first, earliest to reach it wins a tie.
CREATE INDEX IF NOT EXISTS game_bests_board ON game_bests (game, period, score DESC, achieved_at);
