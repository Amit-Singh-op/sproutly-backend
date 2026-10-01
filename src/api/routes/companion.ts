import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { companionAction, ensureQuests, patchCompanion } from '../../core/companion.js';
import { equipSlots, getCatalogItems, getUserInventory, markInventorySeen } from '../../core/inventory.js';
import { getWallet } from '../../core/ledger.js';
import { catalog, markSeen } from '../../core/misc.js';
import { ChatStyleBody, getStyle, saveStyle } from '../../core/styles.js';
import { getCompanion } from '../../core/users.js';
import { getEgg, hatchEgg } from '../../core/eggs.js';
import { claimChest, getChest, weeklyRecap } from '../../core/engagement.js';
import { buy, getShop } from '../../core/shop.js';
import { CATALOG_SLOTS, COMPANION_ACTIONS, MOODS, OUTFITS, PALETTE_IDS } from '../../shared/types.js';

const Patch = z.object({
  name: z.string().max(24).optional(),
  palette: z.enum(PALETTE_IDS).optional(),
  equippedOutfit: z.enum(OUTFITS).optional(),
  equippedSlots: z.record(z.string().optional()).optional(),
  signatureMove: z.enum(MOODS).optional(),
});

const EquipBody = z.object({
  slot: z.enum(CATALOG_SLOTS).optional(),
  itemId: z.string().nullable().optional(),
  slots: z.record(z.string().nullable().optional()).optional(),
});

export async function companionRoutes(app: FastifyInstance) {
  app.get('/companion', async (req) => getCompanion(req.userId));
  app.patch('/companion', async (req) => patchCompanion(req.userId, Patch.parse(req.body) as any));
  app.post('/companion/actions', async (req) => companionAction(req.userId, z.object({ action: z.enum(COMPANION_ACTIONS) }).parse(req.body).action));
  app.get('/quests/today', async (req) => ensureQuests(req.userId));

  // Daily quest chest and the weekly recap.
  app.get('/quests/chest', async (req) => getChest(req.userId));
  app.post('/quests/chest/claim', async (req) => claimChest(req.userId));
  app.get('/recap/week', async (req) => weeklyRecap(req.userId));

  // Eggs: warmed by daily companion actions, hatched when ready.
  app.get('/egg', async (req) => ({ egg: await getEgg(req.userId) }));
  app.post('/egg/hatch', async (req) => hatchEgg(req.userId));

  // Coin shop (weekly featured deal).
  app.get('/shop', async (req) => getShop(req.userId));
  app.post('/shop/buy', async (req) => {
    const { offerId } = z.object({ offerId: z.enum(['scarf', 'flower', 'shield', 'egg']) }).parse(req.body);
    return buy(req.userId, offerId);
  });

  // Catalog (Phase 0 + legacy)
  app.get('/catalog', async (req) => {
    const query = z.object({ kind: z.string().optional(), slot: z.enum(CATALOG_SLOTS).optional() }).parse(req.query);
    if (query.slot) return getCatalogItems(req.userId, query.slot);
    if (query.kind) return catalog(req.userId, query.kind);
    return getCatalogItems(req.userId);
  });
  app.post('/catalog/seen', async (req) => {
    await markSeen(req.userId, z.object({ ids: z.array(z.string()).max(100) }).parse(req.body).ids);
    return { ok: true };
  });

  // User inventory (Phase 0)
  app.get('/inventory', async (req) => getUserInventory(req.userId));
  app.post('/inventory/seen', async (req) => {
    const { ids } = z.object({ ids: z.array(z.string()).max(100) }).parse(req.body);
    await markInventorySeen(req.userId, ids);
    return { ok: true };
  });

  // Multi-slot equip (Phase 0)
  app.patch('/companion/equip', async (req) => {
    const body = EquipBody.parse(req.body);
    return equipSlots(req.userId, body as any);
  });

  // Coins wallet (Phase 0)
  app.get('/wallet', async (req) => getWallet(req.userId));

  // Chat styling
  app.get('/chat-style', async (req) => getStyle(req.userId));
  app.put('/chat-style', async (req) => { await saveStyle(req.userId, ChatStyleBody.parse(req.body)); return { ok: true }; });
}
