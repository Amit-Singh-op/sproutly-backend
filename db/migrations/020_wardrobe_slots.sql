-- Wardrobe slots: catalog_items.slot only allowed the original slots (migration 007), so seeding the new clothes
-- (tops, bottoms, shoes, neckwear) failed. Allow them. Safe to re-run (drops the old rule first).
ALTER TABLE catalog_items DROP CONSTRAINT IF EXISTS catalog_items_slot_check;
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_slot_check
  CHECK (slot IN ('body','head','face','top','bottom','shoes','neck','back','hand','colour','emote','trail','frame'));
