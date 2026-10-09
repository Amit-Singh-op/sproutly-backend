import { redis } from './redis.js';
import { AppError } from './errors.js';

/** "a few seconds", "40 seconds", "3 minutes", "2 hours": how long until the limit resets. */
export function waitText(seconds: number): string {
  if (seconds <= 5) return 'a few seconds';
  if (seconds < 90) return `${Math.ceil(seconds / 5) * 5} seconds`;
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

/**
 * Redis fixed-window counter. Over `points` within `windowS`: throws RATE_LIMITED with a friendly message that says
 * how long to wait (and `retryAfter` seconds, sent as the Retry-After header).
 */
export async function limit(key: string, rule: { points: number; windowS: number }, message?: string) {
  const nowS = Date.now() / 1000;
  const window = Math.floor(nowS / rule.windowS);
  const k = `rl:${key}:${window}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, rule.windowS + 1);
  if (n > rule.points) {
    const retryAfter = Math.max(1, Math.ceil((window + 1) * rule.windowS - nowS));
    const base = (message ?? 'Slow down a little.').replace(/[.!]?$/, '.');
    throw new AppError(429, 'RATE_LIMITED', `${base} Try again in ${waitText(retryAfter)}.`, { retryAfter });
  }
}
