import type pg from 'pg';
import { one, q } from '../db/pool.js';
import { toUsers } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { itemAccess, primaryOutfitFromSlots, resolveEquippedSlots } from '../shared/catalog.js';
import { liveCatalog, liveItem, type LiveItem } from './wardrobe.js';
import type { CatalogItem, CatalogSlot, Companion, EquippedSlots, UserInventoryItem } from '../shared/types.js';
import { isPlus } from './entitlements.js';
import { companionFromRow, getCompanion, peersOf, userStyleOf } from './users.js';

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

  // The live catalog (built-in items with admin overrides). Items that aren't available right now (an expired drop,
  // a hidden item) are left out unless you already own them.
  let items: LiveItem[] = (await liveCatalog()).filter((i) => i.available || invMap.has(i.id));
  if (slot) {
    items = items.filter((i) => i.slot === slot);
  }

  const ctx = { plus, level: userLevel, owned: new Set(invMap.keys()) };
  return items.map((item) => {
    const inv = invMap.get(item.id);
    const access = itemAccess(item, ctx);
    return {
      ...item,
      owned: access.owned,
      locked: !access.owned,
      lockReason: access.owned ? undefined : access.reason,
      isNew: !!inv && !inv.seen,
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

/** Inside a transaction. Returns false when the user already had the item (nothing changes then). */
export async function grantInventoryItemTx(c: pg.PoolClient, userId: string, itemId: string, source: string): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO user_inventory (user_id, item_id, count, source, seen, acquired_at)
     VALUES ($1, $2, 1, $3, FALSE, now()) ON CONFLICT (user_id, item_id) DO NOTHING`,
    [userId, itemId, source],
  );
  return (r.rowCount ?? 0) > 0;
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

  // Validate only what this request changes: an item that was equipped before (e.g. one that used to be free)
  // must not block changing a different slot.
  const inventoryRows = await q<{ item_id: string }>('SELECT item_id FROM user_inventory WHERE user_id = $1', [userId]);
  const ctx = { plus, level: comp.level, owned: new Set(inventoryRows.map((r) => r.item_id)) };
  for (const [slot, itemId] of Object.entries(newSlots)) {
    if (!itemId || itemId === 'none' || (currentSlots as Record<string, string | undefined>)[slot] === itemId) continue;
    const catItem = await liveItem(itemId);
    if (!catItem) throw E.badRequest('Unknown item');
    if (catItem.slot !== slot) throw E.badRequest(`${catItem.name} doesn't go in that slot`);
    const access = itemAccess(catItem, ctx);
    if (access.owned) continue;
    if (access.reason === 'plus') throw E.plusRequired(catItem.name);
    if (access.reason === 'level') throw new AppError(403, 'LEVEL_REQUIRED', `${catItem.name} unlocks at level ${access.level}`, { level: access.level });
    throw new AppError(403, 'NOT_OWNED', `You don't own ${catItem.name} yet`);
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
