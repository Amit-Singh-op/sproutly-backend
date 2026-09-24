import cors from '@fastify/cors';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { getAppConfig } from '../core/appConfig.js';
import { requireApproved } from '../core/approval.js';
import { verifyAccess } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chat.js';
import { companionRoutes } from './routes/companion.js';
import { meRoutes } from './routes/me.js';
import { paymentRoutes } from './routes/payments.js';
import { socialRoutes } from './routes/social.js';
import { webRoutes } from './routes/web.js';

declare module 'fastify' {
  interface FastifyRequest { userId: string }
}

/** Every route except /auth/* and /webhooks/* needs a Bearer JWT. */
export async function authenticate(req: FastifyRequest) {
  const h = req.headers.authorization;
  req.userId = await verifyAccess(h?.startsWith('Bearer ') ? h.slice(7) : null);
}

/** What a signed-in but not-yet-approved user may still do: see their status, delete their account, register push. */
const PENDING_ALLOWED = new Set(['GET /v1/me', 'PATCH /v1/me', 'DELETE /v1/me', 'POST /v1/devices']);

/** Invite-only gate: everything else needs an approved account (403 APPROVAL_PENDING). */
async function approvalGate(req: FastifyRequest) {
  if (PENDING_ALLOWED.has(`${req.method} ${req.routeOptions.url}`)) return;
  await requireApproved(req.userId);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, trustProxy: true, bodyLimit: 256 * 1024 });
  app.decorateRequest('userId', '');
  await app.register(cors, { origin: config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(',') });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ code: err.code, message: err.message, ...err.extra });
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({ code: 'BAD_REQUEST', message: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request' });
    }
    const fe = err as { statusCode?: number; code?: string; message: string };
    if (fe.statusCode && fe.statusCode < 500) return reply.status(fe.statusCode).send({ code: fe.code ?? 'BAD_REQUEST', message: fe.message });
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ code: 'INTERNAL', message: 'Something went wrong' });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ code: 'NOT_FOUND', message: 'Not found' }));

  app.get('/healthz', async () => ({ ok: true }));
  // Public pages for the store listing (privacy, terms, account deletion).
  await app.register(webRoutes);

  await app.register(async (v1) => {
    // Public: the app reads its feature switches before anyone signs in.
    v1.get('/config', async () => getAppConfig());
    await v1.register(authRoutes);
    await v1.register(paymentRoutes);
    await v1.register(async (authed) => {
      authed.addHook('onRequest', authenticate);
      authed.addHook('preHandler', approvalGate);
      await authed.register(meRoutes);
      await authed.register(chatRoutes);
      await authed.register(socialRoutes);
      await authed.register(companionRoutes);
    });
  }, { prefix: '/v1' });

  return app;
}
