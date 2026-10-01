-- Retention: banked streak shields, streak milestones, comeback / companion needs, eggs, friend (chat) streaks,
-- the friend activity feed, seasonal events and first-party analytics. Rules live in src/shared/retention.ts.

-- 1. Companion: when Mo was last looked after, and banked shields (everyone starts with one).
ALTER TABLE companions ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ;
ALTER TABLE companions ADD COLUMN IF NOT EXISTS shields INT NOT NULL DEFAULT 1 CHECK (shields BETWEEN 0 AND 3);
UPDATE companions c SET last_action_at = a.at
  FROM (SELECT user_id, max(created_at) AS at FROM companion_actions GROUP BY user_id) a
 WHERE a.user_id = c.user_id AND c.last_action_at IS NULL;

-- Rewards grant these into user_inventory (FK to catalog_items); make sure they exist even if seed hasn't run.
INSERT INTO catalog_items (id, kind, name, plus_only, sort, slot, rarity, unlock_method, price_coins, description) VALUES
  ('scarf', 'outfit', 'Cozy Scarf', FALSE, 0, 'body', 'common', 'reward', 100, 'Warm knitted winter scarf.'),
  ('flower', 'outfit', 'Flower Crown', FALSE, 0, 'head', 'rare', 'reward', 150, 'Freshly picked blooming blossoms.')
ON CONFLICT (id) DO NOTHING;

-- 2. Streak milestones: each one is granted once per account.
CREATE TABLE IF NOT EXISTS streak_rewards (
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  milestone INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, milestone)
);
-- Existing long streaks shouldn't be paid out for milestones they passed before this shipped.
INSERT INTO streak_rewards (user_id, milestone)
SELECT c.user_id, m.day FROM companions c CROSS JOIN (VALUES (3),(7),(14),(30),(50),(100),(365)) AS m(day)
 WHERE c.streak >= m.day
ON CONFLICT DO NOTHING;

-- 3. Eggs: warmed by one companion action per local day; at most one incubating per user.
CREATE TABLE IF NOT EXISTS eggs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('starter','drop','shop')),
  target INT NOT NULL DEFAULT 3 CHECK (target >= 1),
  progress INT NOT NULL DEFAULT 0 CHECK (progress >= 0),
  last_warm_day DATE,
  reward JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hatched_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS eggs_one_incubating ON eggs (user_id) WHERE hatched_at IS NULL;
CREATE INDEX IF NOT EXISTS eggs_user_idx ON eggs (user_id, created_at DESC);

-- 4. Friend streaks: one row per DM pair (user_a < user_b); a day counts when both message (UTC day).
CREATE TABLE IF NOT EXISTS friend_streaks (
  user_a UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  user_b UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  count INT NOT NULL DEFAULT 0,
  best INT NOT NULL DEFAULT 0,
  last_day DATE,
  a_day DATE,
  b_day DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);

-- 5. Activity feed (in-app only; never pushes).
CREATE TABLE IF NOT EXISTS activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  actor_id UUID REFERENCES users ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('guestbook','room_visit','level_up','streak_milestone','friend_streak','egg_hatched')),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  seen BOOLEAN NOT NULL DEFAULT FALSE,
  -- Dedupe key: a retried job inserting the same row again is a no-op.
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS activity_user_ref ON activity (user_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_user_idx ON activity (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_unseen_idx ON activity (user_id) WHERE NOT seen;

-- 6. Seasonal events: optional daily-drop energy multiplier and an emoji for the banner.
ALTER TABLE events ADD COLUMN IF NOT EXISTS drop_multiplier NUMERIC(3,1) NOT NULL DEFAULT 1 CHECK (drop_multiplier BETWEEN 1 AND 5);
ALTER TABLE events ADD COLUMN IF NOT EXISTS emoji TEXT;
INSERT INTO events (title, description, reward_item_id, starts_at, ends_at, drop_multiplier, emoji)
SELECT * FROM (VALUES
  ('Spooky Sprout Week', 'Daily gifts give double energy all week. Boo!', NULL::text, '2026-10-24T00:00:00Z'::timestamptz, '2026-11-02T00:00:00Z'::timestamptz, 2.0, '🎃'),
  ('Winter Glow', 'Cozy season: daily gifts give double energy until the new year.', NULL::text, '2026-12-20T00:00:00Z'::timestamptz, '2027-01-03T00:00:00Z'::timestamptz, 2.0, '❄️')
) AS v(title, description, reward_item_id, starts_at, ends_at, drop_multiplier, emoji)
WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.title = v.title AND e.starts_at = v.starts_at);

-- 7. First-party analytics (no third parties). Kept 180 days by the cleanup job.
CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users ON DELETE CASCADE,
  name TEXT NOT NULL,
  props JSONB NOT NULL DEFAULT '{}'::jsonb,
  platform TEXT,
  app_version TEXT,
  at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_events_name_at ON analytics_events (name, at);
CREATE INDEX IF NOT EXISTS analytics_events_user_at ON analytics_events (user_id, at);

-- D1 / D7 / D30 retention by sign-up day: a user is retained on day N if they opened the app that day (UTC).
CREATE OR REPLACE VIEW retention_cohorts AS
WITH opens AS (
  SELECT DISTINCT user_id, (at AT TIME ZONE 'UTC')::date AS day FROM analytics_events WHERE name = 'app_open' AND user_id IS NOT NULL
)
SELECT (u.created_at AT TIME ZONE 'UTC')::date AS cohort,
       count(*) AS users,
       round(100.0 * count(*) FILTER (WHERE EXISTS (SELECT 1 FROM opens o WHERE o.user_id = u.id AND o.day = (u.created_at AT TIME ZONE 'UTC')::date + 1)) / count(*), 1) AS d1_pct,
       round(100.0 * count(*) FILTER (WHERE EXISTS (SELECT 1 FROM opens o WHERE o.user_id = u.id AND o.day = (u.created_at AT TIME ZONE 'UTC')::date + 7)) / count(*), 1) AS d7_pct,
       round(100.0 * count(*) FILTER (WHERE EXISTS (SELECT 1 FROM opens o WHERE o.user_id = u.id AND o.day = (u.created_at AT TIME ZONE 'UTC')::date + 30)) / count(*), 1) AS d30_pct
  FROM users u
 GROUP BY 1
 ORDER BY 1 DESC;
