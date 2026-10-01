import type pg from 'pg';
import { one, pool, q, tx, type Db } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { localDay } from '../lib/time.js';
import { MAX_SHIELDS, SHOP_OFFERS, featuredOffer, offerPrice, shopWeekEnds } from '../shared/retention.js';
import type { Egg, Shop, ShopOfferId, ShopPurchase } from '../shared/types.js';
import { getEgg, startEgg } from './eggs.js';
import { grantInventoryItemTx } from './inventory.js';
import { adjustCoinsTx } from './ledger.js';

async function shopFor(userId: string, db: Db, at = new Date()): Promise<Shop> {
  const comp = await one<{ coins: number; shields: number }>('SELECT coins, shields FROM companions WHERE user_id = $1', [userId], db);
  if (!comp) throw E.notFound('Companion not found');
  const owned = new Set((await q<{ item_id: string }>('SELECT item_id FROM user_inventory WHERE user_id = $1', [userId], db)).map((r) => r.item_id));
  const incubating = !!(await one('SELECT 1 FROM eggs WHERE user_id = $1 AND hatched_at IS NULL', [userId], db));
  const featured = featuredOffer(at);
  return {
    coins: comp.coins,
    shields: comp.shields,
    endsAt: shopWeekEnds(at),
    offers: SHOP_OFFERS.map((o) => {
      const reason = o.kind === 'item' && owned.has(o.id) ? 'You own this'
        : o.kind === 'shield' && comp.shields >= MAX_SHIELDS ? `You have the most shields (${MAX_SHIELDS})`
        : o.kind === 'egg' && incubating ? 'Hatch your egg first'
        : undefined;
      return {
        id: o.id, kind: o.kind, name: o.name, description: o.description,
        price: offerPrice(o.id, at), basePrice: o.price, featured: o.id === featured,
        available: !reason, ...(reason ? { reason } : {}),
      };
    }),
  };
}

export async function getShop(userId: string): Promise<Shop> {
  return shopFor(userId, pool);
}

/**
 * Coins only. The price is the one shown this week (featured deal included). Everything happens in one transaction,
 * so coins are never taken without the item arriving (and vice versa).
 */
export async function buy(userId: string, offerId: ShopOfferId): Promise<ShopPurchase> {
  const offer = SHOP_OFFERS.find((o) => o.id === offerId);
  if (!offer) throw E.badRequest('Unknown shop item');
  const out = await tx(async (c: pg.PoolClient) => {
    const at = new Date();
    // Lock first: two taps can't both pass the checks below.
    const comp = await one<{ coins: number; shields: number; timezone: string }>(
      'SELECT c.coins, c.shields, u.timezone FROM companions c JOIN users u ON u.id = c.user_id WHERE c.user_id = $1 FOR UPDATE OF c', [userId], c,
    );
    if (!comp) throw E.notFound('Companion not found');
    const price = offerPrice(offer.id, at);
    if (comp.coins < price) throw new AppError(400, 'INSUFFICIENT_COINS', `You need ${price - comp.coins} more coins`);
    let itemId: string | null = null;
    if (offer.kind === 'item') {
      if (!(await grantInventoryItemTx(c, userId, offer.id, 'shop'))) throw new AppError(409, 'ALREADY_OWNED', `You already own ${offer.name}`);
      itemId = offer.id;
    } else if (offer.kind === 'shield') {
      if (comp.shields >= MAX_SHIELDS) throw new AppError(409, 'SHIELDS_FULL', `You already have ${MAX_SHIELDS} shields`);
      await c.query('UPDATE companions SET shields = shields + 1 WHERE user_id = $1', [userId]);
    } else if (!(await startEgg(c, userId, 'shop'))) {
      throw new AppError(409, 'EGG_INCUBATING', 'Hatch your egg first');
    }
    // Item purchases are one-off (reference = item); shields and eggs can be bought again, so each gets its own.
    const ref = offer.kind === 'item' ? `shop:${offer.id}` : `shop:${offer.id}:${localDay(comp.timezone)}:${Date.now()}`;
    const wallet = await adjustCoinsTx(c, userId, -price, 'shop', ref);
    if (!wallet.applied) throw new AppError(409, 'ALREADY_OWNED', `You already own ${offer.name}`);
    return { coins: wallet.coins, itemId, shop: await shopFor(userId, c, at) };
  });
  toUser(userId, 'wallet:update', { coins: out.coins });
  const egg: Egg | null = offer.kind === 'egg' ? await getEgg(userId) : null;
  return { shop: out.shop, coins: out.coins, shields: out.shop.shields, itemId: out.itemId, egg };
}
