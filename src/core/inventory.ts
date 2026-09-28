import { one, q } from '../db/pool.js';
import { toUsers } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { CATALOG_ITEMS, getCatalogItem, primaryOutfitFromSlots, resolveEquippedSlots } from '../shared/catalog.js';
import type { CatalogItem, CatalogSlot, Companion, EquippedSlots, Outfit, UserInventoryItem } from '../shared/types.js';
import { isPlus } from './entitlements.js';
import { companionFromRow, getCompanion, peersOf, userStyleOf } from './users.js';

interface CatalogDbRow {
  id: string;
  name: string;
  slot: CatalogSlot;
  rarity: string;
  unlock_method: string;
  unlock_requirement: string | null;
  plus_only: boolean;
  price_coins: number | null;
  description: string | null;
}

interface InventoryDbRow {
  item_id: string;
  count: number;
  source: string;
  seen: boolean;
  acquired_at: Date;
}

export async function getCatalogItems(userId: string, slot?: CatalogSlot): Promise<CatalogItem[]> {
  const plus = await isPlus(userId);
  const comp = await one<{ level: number }>('SELECT level FROM companions WHERE user_id = $1', [userId]);
  const userLevel = comp?.level ?? 1;

  // Read inventory
  const inventoryRows = await q<{ item_id: string; seen: boolean }>(
    'SELECT item_id, seen FROM user_inventory WHERE user_id = $1',
    [userId],
  );
  const invMap = new Map(inventoryRows.map((r) => [r.item_id, r]));

  // Pull catalog items from DB if populated, falling back to CATALOG_ITEMS
  let items = CATALOG_ITEMS;
  if (slot) {
    items = items.filter((i) => i.slot === slot);
  }

  return items.map((item) => {
    const inv = invMap.get(item.id);
    const reqLevel = typeof item.unlockRequirement === 'number' ? item.unlockRequirement : item.unlockRequirement ? parseInt(item.unlockRequirement, 10) : 0;
    const isStarter = item.unlockMethod === 'starter';
    const isOwned = isStarter || !!inv || (item.plusOnly && plus);
    const isLocked = (item.plusOnly && !plus) || (reqLevel > 0 && userLevel < reqLevel);
    const isNew = !!inv && !inv.seen;

    return {
      ...item,
      owned: isOwned,
      locked: isLocked,
      isNew,
    };
  });
}

export async function getUserInventory(userId: string): Promise<UserInventoryItem[]> {
  const rows = await q<InventoryDbRow>(
    'SELECT item_id, count, source, seen, acquired_at FROM user_inventory WHERE user_id = $1 ORDER BY acquired_at DESC',
    [userId],
  );
  return rows.map((r) => ({
    itemId: r.item_id,
    count: r.count,
    source: r.source as any,
    seen: r.seen,
    acquiredAt: r.acquired_at.toISOString(),
  }));
}

export async function markInventorySeen(userId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  await q(
    'UPDATE user_inventory SET seen = TRUE WHERE user_id = $1 AND item_id = ANY($2::text[])',
    [userId, itemIds],
  );
}

export async function grantInventoryItem(userId: string, itemId: string, source = 'starter', count = 1): Promise<void> {
  await q(
    `INSERT INTO user_inventory (user_id, item_id, count, source, seen, acquired_at)
     VALUES ($1, $2, $3, $4, FALSE, now())
     ON CONFLICT (user_id, item_id) DO UPDATE SET count = user_inventory.count + EXCLUDED.count`,
    [userId, itemId, count, source],
  );
}

export async function equipSlots(
  userId: string,
  update: { slot?: CatalogSlot; itemId?: string | null; slots?: Partial<EquippedSlots> },
): Promise<Companion> {
  const comp = await getCompanion(userId);
  const plus = await isPlus(userId);

  const currentSlots: EquippedSlots = resolveEquippedSlots(comp.equippedSlots, comp.equippedOutfit);
  const newSlots: Record<string, string | undefined> = { ...currentSlots };

  if (update.slot) {
    if (!update.itemId || update.itemId === 'none') {
      delete newSlots[update.slot];
    } else {
      newSlots[update.slot] = update.itemId;
    }
  }

  if (update.slots) {
    for (const [k, v] of Object.entries(update.slots)) {
      if (!v || v === 'none') {
        delete newSlots[k];
      } else {
        newSlots[k] = v;
      }
    }
  }

  // Validate items
  const inventoryRows = await q<{ item_id: string }>(
    'SELECT item_id FROM user_inventory WHERE user_id = $1',
    [userId],
  );
  const ownedItemIds = new Set(inventoryRows.map((r) => r.item_id));

  for (const [slot, itemId] of Object.entries(newSlots)) {
    if (!itemId || itemId === 'none') continue;
    const catItem = getCatalogItem(itemId);
    if (catItem) {
      if (catItem.plusOnly && !plus) {
        throw E.plusRequired(catItem.name);
      }
      const reqLvl = typeof catItem.unlockRequirement === 'number' ? catItem.unlockRequirement : catItem.unlockRequirement ? parseInt(catItem.unlockRequirement, 10) : 0;
      if (reqLvl > 0 && comp.level < reqLvl) {
        throw new AppError(403, 'LEVEL_REQUIRED', `${catItem.name} unlocks at level ${reqLvl}`, { level: reqLvl });
      }
      if (catItem.unlockMethod !== 'starter' && !ownedItemIds.has(itemId) && !catItem.plusOnly) {
        throw E.forbidden(`You do not own ${catItem.name}`);
      }
    }
  }

  const primaryOutfit = primaryOutfitFromSlots(newSlots as EquippedSlots);

  const r = await one<Parameters<typeof companionFromRow>[0]>(
    `UPDATE companions
     SET equipped_slots = $2::jsonb, equipped_outfit = $3, updated_at = now()
     WHERE user_id = $1
     RETURNING *`,
    [userId, JSON.stringify(newSlots), primaryOutfit],
  );

  const style = await userStyleOf(userId);
  if (style) toUsers([...(await peersOf(userId)), userId], 'style:update', style);

  return companionFromRow(r!);
}
