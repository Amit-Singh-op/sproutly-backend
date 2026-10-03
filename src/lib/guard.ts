/**
 * Request hardening shared by the API and the realtime server:
 * - per-IP limits on the HTTP API (a general cap, tighter on sign-in, so codes can't be sprayed or brute-forced
 *   from one place across many accounts);
 * - security headers on every response (stricter content policy on the public web pages);
 * - a per-connection flood guard for socket events (generous for real use; a modified client spamming events is
 *   dropped and then disconnected).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Socket } from 'socket.io';
import { limit } from './ratelimit.js';
import { AppError } from './errors.js';

const IP_RULES = {
  /** Everything: a busy app makes a few requests a second at most. */
  general: { points: 600, windowS: 60 },
  /** Sign-in endpoints (start/verify code, refresh, social sign-in). */
  auth: { points: 30, windowS: 60 },
  /** Asking for a code: stops one address emailing codes to many accounts. */
  otpStart: { points: 15, windowS: 3600 },
} as const;

/** Paths that must never be throttled by IP (payment webhooks come from the store's servers; health checks). */
const EXEMPT = [/^\/healthz/, /^\/v1\/webhooks\//];

/** Local test servers only (many accounts from one machine): IP_LIMITS=off. On everywhere else by default. */
const IP_LIMITS_ON = process.env.IP_LIMITS !== 'off';

async function checkIp(req: FastifyRequest) {
  if (!IP_LIMITS_ON) return;
  const path = req.url.split('?')[0] ?? '';
  if (EXEMPT.some((r) => r.test(path))) return;
  const ip = req.ip || 'unknown';
  try {
    await limit(`ip:${ip}`, IP_RULES.general, 'Too many requests. Slow down a little.');
    if (path.startsWith('/v1/auth/')) await limit(`ipauth:${ip}`, IP_RULES.auth, 'Too many sign-in attempts. Try again in a minute.');
    if (path === '/v1/auth/otp/start') await limit(`ipotp:${ip}`, IP_RULES.otpStart, 'Too many codes requested from this network. Try again later.');
  } catch (e) {
    if (e instanceof AppError) throw e;
    // The limiter's store is unreachable: let the request through rather than take the whole app down.
  }
}

function headers(req: FastifyRequest, reply: FastifyReply) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  const type = String(reply.getHeader('content-type') ?? '');
  if (type.includes('text/html')) {
    // Public pages (privacy, terms, account deletion): inline styles and a small inline form script only.
    reply.header('Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  } else {
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
  reply.header('Cache-Control', req.url.startsWith('/v1/') ? 'no-store' : String(reply.getHeader('cache-control') ?? 'no-cache'));
}

export function registerHttpGuards(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => { await checkIp(req); });
  app.addHook('onSend', async (req, reply, payload) => { headers(req, reply); return payload; });
}

/**
 * Socket flood guard: a token bucket per connection (bursts of 40 events, refilling 20 a second). Events over the
 * limit are dropped with an error; a connection that keeps flooding is disconnected.
 */
export function guardSocket(socket: Socket) {
  const CAP = 40, REFILL_PER_S = 20, STRIKES = 50;
  let tokens = CAP, last = Date.now(), strikes = 0;
  socket.use((_packet, next) => {
    const now = Date.now();
    tokens = Math.min(CAP, tokens + ((now - last) / 1000) * REFILL_PER_S);
    last = now;
    if (tokens >= 1) { tokens -= 1; return next(); }
    if (++strikes >= STRIKES) { socket.disconnect(true); return; }
    next(new Error('rate limited'));
  });
}
