import { redis } from './redis.js';
import { E } from './errors.js';

/** Redis fixed-window counter. Throws RATE_LIMITED when `points` is exceeded within `windowS`. */
export async function limit(key: string, rule: { points: number; windowS: number }, message?: string) {
  const window = Math.floor(Date.now() / 1000 / rule.windowS);
  const k = `rl:${key}:${window}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, rule.windowS + 1);
  if (n > rule.points) throw E.rateLimited(message);
}
