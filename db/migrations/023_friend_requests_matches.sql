-- Friend requests and 1v1 matches.
--
-- Friend requests use the existing friendships table: a request is one row (sender -> receiver, 'pending'); accepting
-- turns it into the usual pair of 'accepted' rows. Friendships made before this (instant, mutual) stay as they are.
CREATE INDEX IF NOT EXISTS friendships_incoming ON friendships (friend_id, status);

-- New activity kinds: friend requests/accepts and 1v1 challenges.
ALTER TABLE activity DROP CONSTRAINT IF EXISTS activity_kind_check;
ALTER TABLE activity ADD CONSTRAINT activity_kind_check CHECK (kind IN (
  'guestbook','room_visit','level_up','streak_milestone','friend_streak','egg_hatched',
  'friend_request','friend_accept','match_invite','match_result'
));

-- 1v1 matches between friends.
--   kind 'race': both play the same minigame at the same moment (starts_at); higher score wins.
--   kind 'turn': a board game (tic-tac-toe, four in a row, rock-paper-scissors) played move by move; the server
--                checks every move and keeps the board in `state`.
-- a_id challenged b_id. winner_id NULL on a finished match = a draw.
CREATE TABLE IF NOT EXISTS game_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('race', 'turn')),
  a_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  b_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'done', 'declined', 'cancelled', 'expired')),
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  a_score INTEGER,
  b_score INTEGER,
  winner_id UUID,
  turn_id UUID,
  -- Why it ended when it wasn't simply played out: 'forfeit' (someone left), 'timeout' (no move in time).
  end_reason TEXT,
  starts_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS game_matches_a ON game_matches (a_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS game_matches_b ON game_matches (b_id, status, updated_at DESC);
