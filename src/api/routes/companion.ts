import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { companionAction, ensureQuests, patchCompanion } from '../../core/companion.js';
import { catalog, markSeen } from '../../core/misc.js';
import { ChatStyleBody, getStyle, saveStyle } from '../../core/styles.js';
import { getCompanion } from '../../core/users.js';
import { COMPANION_ACTIONS, MOODS, OUTFITS, PALETTE_IDS } from '../../shared/types.js';

const Patch = z.object({ name: z.string().max(24).optional(), palette: z.enum(PALETTE_IDS).optional(), equippedOutfit: z.enum(OUTFITS).optional(), signatureMove: z.enum(MOODS).optional() });

export async function companionRoutes(app: FastifyInstance) {
  app.get('/companion', async (req) => getCompanion(req.userId));
  app.patch('/companion', async (req) => patchCompanion(req.userId, Patch.parse(req.body)));
  app.post('/companion/actions', async (req) => companionAction(req.userId, z.object({ action: z.enum(COMPANION_ACTIONS) }).parse(req.body).action));
  app.get('/quests/today', async (req) => ensureQuests(req.userId));

  app.get('/catalog', async (req) => catalog(req.userId, z.object({ kind: z.string() }).parse(req.query).kind));
  app.post('/catalog/seen', async (req) => { await markSeen(req.userId, z.object({ ids: z.array(z.string()).max(100) }).parse(req.body).ids); return { ok: true }; });

  app.get('/chat-style', async (req) => getStyle(req.userId));
  app.put('/chat-style', async (req) => { await saveStyle(req.userId, ChatStyleBody.parse(req.body)); return { ok: true }; });
}
