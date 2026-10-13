import cors from '@fastify/cors';
import { registerHttpGuards } from '../lib/guard.js';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { AppError, GENERIC_MESSAGE, publicHttpMessage, publicValidationMessage } from '../lib/errors.js';
import { getAppConfig } from '../core/appConfig.js';
import { requireApproved } from '../core/approval.js';
import { verifyAccess } from '../lib/jwt.js';
import { actionGate } from '../lib/actionLimits.js';
import { requireNotSuspended } from '../core/suspension.js';
import { log } from '../lib/log.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chat.js';
import { companionRoutes } from './routes/companion.js';
import { gameRoutes } from './routes/games.js';
import { matchRoutes } from './routes/matches.js';
import { meRoutes } from './routes/me.js';
import { paymentRoutes } from './routes/payments.js';
import { socialRoutes } from './routes/social.js';
import { webRoutes } from './routes/web.js';
import { adminRoutes } from './routes/admin.js';
import { deviceIdOf, recordClient } from '../core/moderation.js';
import { cloudinaryHookRoutes } from './routes/cloudinaryHook.js';

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

/** Suspended accounts can't use anything (403 ACCOUNT_SUSPENDED with the reason) except deleting themselves. */
async function suspensionGate(req: FastifyRequest) {
  if (`${req.method} ${req.routeOptions.url}` === 'DELETE /v1/me') return;
  await requireNotSuspended(req.userId);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger, trustProxy: true, bodyLimit: 256 * 1024 });
  app.decorateRequest('userId', '');
  // Treat an empty JSON body as "no body" instead of rejecting it: DELETE/POST requests without a payload that
  // still send Content-Type: application/json (e.g. un-voting a poll from older app builds) must keep working.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, raw, done) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    // Webhooks check a signature over the exact bytes received.
    (req as unknown as { rawBody?: string }).rawBody = text;
    if (text.trim() === '') return done(null, undefined);
    try { done(null, JSON.parse(text)); } catch {
      const e = new Error('Invalid JSON') as Error & { statusCode: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });
  await app.register(cors, { origin: config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(',') });
  // Per-IP limits and security headers on every response.
  registerHttpGuards(app);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      // Rate limits say how long to wait, in the message and as the standard Retry-After header.
      if (typeof err.extra.retryAfter === 'number') reply.header('Retry-After', String(err.extra.retryAfter));
      return reply.status(err.status).send({ code: err.code, message: err.message, ...err.extra });
    }
    // Only AppErrors (our own wording) reach users verbatim. Validation and framework errors get a generic message;
    // the technical detail goes to the logs instead.
    if (err instanceof ZodError) {
      req.log.info({ issues: err.issues, url: req.url }, 'validation failed');
      return reply.status(400).send({ code: 'BAD_REQUEST', message: publicValidationMessage(err.issues) });
    }
    const fe = err as { statusCode?: number; code?: string; message: string };
    if (fe.statusCode && fe.statusCode < 500) {
      req.log.info({ code: fe.code, msg: fe.message, url: req.url }, 'request rejected');
      return reply.status(fe.statusCode).send(publicHttpMessage(fe.statusCode));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ code: 'INTERNAL', message: GENERIC_MESSAGE });
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
    await v1.register(cloudinaryHookRoutes);
    await v1.register(async (authed) => {
      authed.addHook('onRequest', authenticate);
      authed.addHook('preHandler', suspensionGate);
      // Where this account was last used (network address + app install), read only by moderation records.
      authed.addHook('onResponse', async (req) => { if (req.userId) void recordClient(req.userId, req.ip, deviceIdOf(req.headers['x-device-id'])); });
      authed.addHook('preHandler', approvalGate);
      // Per-account limits: overall, and per action (reports, friend requests, buying, posting...).
      authed.addHook('preHandler', actionGate);
      await authed.register(meRoutes);
      await authed.register(chatRoutes);
      await authed.register(socialRoutes);
      await authed.register(companionRoutes);
      await authed.register(gameRoutes);
      await authed.register(matchRoutes);
      await authed.register(adminRoutes);
    });
  }, { prefix: '/v1' });

  return app;
}
