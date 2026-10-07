/**
 * Wardrobe (Phase 1): the live catalog (built-in items plus admin overrides from catalog_overrides, so prices, drops
 * and Plus-only status change without an app release), buying items with coins, and saved looks.
 */
import type pg from 'pg';
import { one, q, tx } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { CATALOG_ITEMS, itemAccess, requiredLevel } from '../shared/catalog.js';
import { CATALOG_SLOTS, type CatalogItem, type EquippedSlots } from '../shared/types.js';
import { isPlus } from './entitlements.js';
import { grantInventoryItemTx } from './inventory.js';
import { adjustCoinsTx } from './ledger.js';

interface OverrideRow {
  item_id: string;
  price_coins: number | null;
  plus_only: boolean | null;
  available_from: Date | null;
  available_until: Date | null;
  hidden: boolean;
  is_new: boolean;
}

/** A catalog item as it is right now, with overrides applied. `available` = can be bought or unlocked today. */
export type LiveItem = CatalogItem & { available: boolean; availableUntil?: string; featuredNew?: boolean };

const CACHE_MS = 60_000;
let cache: { at: number; rows: Map<string, OverrideRow> } | null = null;

async function overrides(): Promise<Map<string, OverrideRow>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  try {
    const rows = await q<OverrideRow>('SELECT item_id, price_coins, plus_only, available_from, available_until, hidden, is_new FROM catalog_overrides');
    cache = { at: Date.now(), rows: new Map(rows.map((r) => [r.item_id, r])) };
  } catch {
    // Table missing or DB hiccup: the built-in catalog still works.
    cache = { at: Date.now(), rows: cache?.rows ?? new Map() };
  }
  return cache.rows;
}

function apply(item: CatalogItem, o: OverrideRow | undefined, now: number): LiveItem {
  if (!o) return { ...item, available: true };
  const inWindow = (!o.available_from || o.available_from.getTime() <= now) && (!o.available_until || o.available_until.getTime() > now);
  return {
    ...item,
    ...(o.price_coins != null ? { priceCoins: o.price_coins } : {}),
    ...(o.plus_only != null ? { plusOnly: o.plus_only } : {}),
    available: !o.hidden && inWindow,
    ...(o.available_until && inWindow ? { availableUntil: o.available_until.toISOString() } : {}),
    ...(o.is_new && inWindow ? { featuredNew: true } : {}),
  };
}

export async function liveCatalog(): Promise<LiveItem[]> {
  const o = await overrides();
  const now = Date.now();
  return CATALOG_ITEMS.map((i) => apply(i, o.get(i.id), now));
}

export async function liveItem(id: string): Promise<LiveItem | undefined> {
  const item = CATALOG_ITEMS.find((i) => i.id === id);
  if (!item) return undefined;
  return apply(item, (await overrides()).get(id), Date.now());
}

/**
 * Buys a catalog item with coins (items sold in the wardrobe: unlockMethod 'shop', or any item an override prices).
 * One transaction: coins are never taken without the item arriving, and two taps can't buy it twice.
 */
export async function buyItem(userId: string, itemId: string): Promise<{ coins: number; itemId: string }> {
  const item = await liveItem(itemId);
  if (!item) throw E.badRequest('Unknown item');
  if (!item.available) throw new AppError(409, 'NOT_AVAILABLE', `${item.name} isn't available right now`);
  const price = item.priceCoins;
  if (!price || (item.unlockMethod !== 'shop' && item.unlockMethod !== 'reward')) {
    throw new AppError(400, 'NOT_FOR_SALE', `${item.name} can't be bought with coins`);
  }
  if (item.plusOnly && !(await isPlus(userId))) throw E.plusRequired(item.name);

  const out = await tx(async (c: pg.PoolClient) => {
    const comp = await one<{ coins: number; level: number }>('SELECT coins, level FROM companions WHERE user_id = $1 FOR UPDATE', [userId], c);
    if (!comp) throw E.notFound('Companion not found');
    const lvl = requiredLevel(item);
    if (lvl > 0 && comp.level < lvl) throw new AppError(403, 'LEVEL_REQUIRED', `${item.name} unlocks at level ${lvl}`, { level: lvl });
    if (comp.coins < price) throw new AppError(400, 'INSUFFICIENT_COINS', `You need ${price - comp.coins} more coins`);
    if (!(await grantInventoryItemTx(c, userId, item.id, 'shop'))) throw new AppError(409, 'ALREADY_OWNED', `You already own ${item.name}`);
    const wallet = await adjustCoinsTx(c, userId, -price, 'wardrobe', `wardrobe:${item.id}`);
    if (!wallet.applied) throw new AppError(409, 'ALREADY_OWNED', `You already own ${item.name}`);
    return { coins: wallet.coins };
  });
  toUser(userId, 'wallet:update', { coins: out.coins });
  return { coins: out.coins, itemId: item.id };
}

// ---------------- saved looks ----------------

export interface Look { idx: number; name: string; slots: EquippedSlots }

const LOOK_SLOTS = new Set<string>(CATALOG_SLOTS.filter((s) => s !== 'colour' && s !== 'emote' && s !== 'frame'));

export async function getLooks(userId: string): Promise<Look[]> {
  const rows = await q<{ idx: number; name: string; slots: EquippedSlots }>(
    'SELECT idx, name, slots FROM companion_looks WHERE user_id = $1 ORDER BY idx', [userId],
  );
  return rows.map((r) => ({ idx: r.idx, name: r.name, slots: r.slots ?? {} }));
}

/** Saves (or replaces) look 0, 1 or 2. Only wearable slots are kept; wearing it later checks ownership as usual. */
export async function saveLook(userId: string, idx: number, name: string, slots: Record<string, string | null | undefined>): Promise<Look> {
  if (!Number.isInteger(idx) || idx < 0 || idx > 2) throw E.badRequest('Pick one of your three looks');
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(slots)) {
    if (LOOK_SLOTS.has(k) && typeof v === 'string' && v && v !== 'none' && CATALOG_ITEMS.some((i) => i.id === v && i.slot === k)) clean[k] = v;
  }
  const label = name.trim().slice(0, 24) || `Look ${idx + 1}`;
  await q(
    `INSERT INTO companion_looks (user_id, idx, name, slots, updated_at) VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (user_id, idx) DO UPDATE SET name = EXCLUDED.name, slots = EXCLUDED.slots, updated_at = now()`,
    [userId, idx, label, JSON.stringify(clean)],
  );
  return { idx, name: label, slots: clean as EquippedSlots };
}

export { itemAccess };
