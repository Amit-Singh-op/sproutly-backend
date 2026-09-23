import { log } from './log.js';
import { redis } from './redis.js';

const EVERY_MS = 10 * 60 * 1000; // under Render free tier's 15-minute idle spin-down

/**
 * Keeps a free-tier web service (Render) from sleeping: every 10 min it calls its own public /healthz, which
 * counts as inbound traffic, and pings Redis so a broken connection is noticed and reconnected.
 * Postgres (Neon) is deliberately NOT kept awake: it wakes in < 1 s and free compute hours are limited.
 * Active when KEEP_ALIVE_URL is set, or automatically on Render (RENDER_EXTERNAL_URL). KEEP_ALIVE=false disables it.
 */
export function startKeepAlive() {
  if (process.env.KEEP_ALIVE === 'false') return;
  const base = (process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (!base) return;
  const tick = async () => {
    try {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) log.warn({ status: res.status }, 'keep-alive: healthz not ok');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'keep-alive: self ping failed');
    }
    try {
      await redis.ping();
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'keep-alive: redis ping failed');
    }
  };
  setInterval(() => { void tick(); }, EVERY_MS).unref();
  log.info(`keep-alive on: pinging ${base}/healthz and Redis every ${EVERY_MS / 60000} min`);
}
