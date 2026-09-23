import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { handleWebhook, syncFromRevenueCat } from '../../core/revenuecat.js';
import { E } from '../../lib/errors.js';
import { limit } from '../../lib/ratelimit.js';
import { authenticate } from '../app.js';

function authorized(header: string | undefined) {
  if (!header) return false;
  const expected = Buffer.from(config.REVENUECAT_WEBHOOK_AUTH);
  // RevenueCat sends the configured value verbatim; accept it with or without a "Bearer " prefix.
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function paymentRoutes(app: FastifyInstance) {
  /** Doc section 5: RevenueCat webhook. Always 200 once authenticated and stored, so RevenueCat doesn't retry forever. */
  app.post('/webhooks/revenuecat', async (req, reply) => {
    if (!authorized(req.headers.authorization)) throw E.unauthorized('Bad webhook credentials');
    const result = await handleWebhook(req.body);
    req.log.info({ result }, 'revenuecat webhook');
    return reply.status(200).send({ ok: true, result });
  });

  /** App calls this right after a purchase/restore: re-read the subscriber from RevenueCat and update entitlements now. */
  app.post('/purchases/sync', { onRequest: authenticate }, async (req) => {
    await limit(`rcsync:${req.userId}`, { points: 10, windowS: 60 });
    return syncFromRevenueCat(req.userId);
  });
}
