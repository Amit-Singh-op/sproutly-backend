-- Phase 0: Foundations - Item Catalog v2, User Inventory, Multi-slot Equipping, Coins Wallet & XP Ledger

-- 1. Extend companions with coins and multi-slot equipped mapping
ALTER TABLE companions ADD COLUMN IF NOT EXISTS coins INT NOT NULL DEFAULT 0 CHECK (coins >= 0);
ALTER TABLE companions ADD COLUMN IF NOT EXISTS equipped_slots JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE catalog_items DROP CONSTRAINT IF EXISTS catalog_items_kind_check;

-- 2. Extend catalog_items with slot, rarity, unlock method & price
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS slot TEXT NOT NULL DEFAULT 'head'
  CHECK (slot IN ('body','head','face','back','hand','colour','emote','trail','frame'));
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS rarity TEXT NOT NULL DEFAULT 'common'
  CHECK (rarity IN ('common','rare','epic','legendary','mythic'));
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS unlock_method TEXT NOT NULL DEFAULT 'starter'
  CHECK (unlock_method IN ('starter','level','streak','quest','egg','plus','reward','shop'));
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS unlock_requirement TEXT;
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS price_coins INT CHECK (price_coins >= 0);
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS description TEXT;

-- 3. User Inventory table with count, source and seen tracking
CREATE TABLE IF NOT EXISTS user_inventory (
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES catalog_items ON DELETE CASCADE,
  count INT NOT NULL DEFAULT 1 CHECK (count >= 1),
  source TEXT NOT NULL DEFAULT 'starter' CHECK (source IN ('starter','level','streak','quest','egg','plus','reward','shop','drop')),
  seen BOOLEAN NOT NULL DEFAULT FALSE,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_user_inventory_user_seen ON user_inventory (user_id, seen);

-- Backfill inventory from existing user_items if any
DO $$
BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'user_items') THEN
    INSERT INTO user_inventory (user_id, item_id, count, source, seen, acquired_at)
    SELECT user_id, item_id, 1, 'starter', seen, acquired_at FROM user_items
    ON CONFLICT (user_id, item_id) DO NOTHING;
  END IF;
END $$;

-- 4. Append-only Coin transactions ledger (idempotent via reference_id)
CREATE TABLE IF NOT EXISTS coin_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  amount INT NOT NULL,
  balance_after INT NOT NULL CHECK (balance_after >= 0),
  source TEXT NOT NULL,
  reference_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, reference_id)
);
CREATE INDEX IF NOT EXISTS idx_coin_transactions_user ON coin_transactions (user_id, created_at DESC);

-- 5. XP Ledger with daily caps per source
CREATE TABLE IF NOT EXISTS xp_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE,
  amount INT NOT NULL CHECK (amount > 0),
  source TEXT NOT NULL CHECK (source IN ('message','room_visit','group_join','daily_login','quest','invite','companion_action')),
  day DATE NOT NULL,
  reference_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, reference_id)
);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_user_day_source ON xp_ledger (user_id, day, source);

-- 6. Feature flags in app_config
INSERT INTO app_config (key, value) VALUES
  ('phase_0_foundations', 'true'::jsonb),
  ('phase_1_idle_feelings', 'false'::jsonb),
  ('phase_2_progression', 'false'::jsonb),
  ('phase_3_customisation', 'false'::jsonb),
  ('phase_4_social', 'false'::jsonb),
  ('phase_5_retention', 'false'::jsonb),
  ('phase_6_collectibles', 'false'::jsonb),
  ('phase_7_rooms', 'false'::jsonb),
  ('phase_8_minigames', 'false'::jsonb),
  ('phase_9_plus_perks', 'false'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
