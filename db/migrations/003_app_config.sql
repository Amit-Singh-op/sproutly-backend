-- Runtime switches the app reads at launch (GET /v1/config). Change a value in the DB and apps pick it up
-- on their next launch/refresh; no deploy or app update needed.
--   UPDATE app_config SET value = 'true' WHERE key = 'plus_enabled';   -- open Plus purchases
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Plus launches later: the app shows "Coming soon" instead of the paywall while this is false.
INSERT INTO app_config (key, value) VALUES ('plus_enabled', 'false') ON CONFLICT (key) DO NOTHING;
