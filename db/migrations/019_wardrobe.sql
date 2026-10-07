-- Wardrobe (Phase 1).
--
-- catalog_overrides: change any catalog item without an app release. Every column is optional; NULL keeps the item's
-- built-in value. Takes effect within about a minute. Examples:
--   Weekly drop:   INSERT INTO catalog_overrides (item_id, available_from, available_until, is_new)
--                  VALUES ('varsity', now(), now() + interval '7 days', TRUE);
--   Sale:          INSERT INTO catalog_overrides (item_id, price_coins) VALUES ('bomber', 99)
--                  ON CONFLICT (item_id) DO UPDATE SET price_coins = 99;
--   Make Plus-only: ... (item_id, plus_only) VALUES ('knit', TRUE) ...
--   Hide an item:  ... (item_id, hidden) VALUES ('skirt', TRUE) ...   (people who own it keep it)
CREATE TABLE IF NOT EXISTS catalog_overrides (
  item_id TEXT PRIMARY KEY,
  price_coins INTEGER CHECK (price_coins IS NULL OR price_coins >= 0),
  plus_only BOOLEAN,
  available_from TIMESTAMPTZ,
  available_until TIMESTAMPTZ,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  is_new BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Saved looks: up to three outfits per person, applied with one tap in the closet.
CREATE TABLE IF NOT EXISTS companion_looks (
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  idx SMALLINT NOT NULL CHECK (idx BETWEEN 0 AND 2),
  name TEXT NOT NULL,
  slots JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idx)
);
