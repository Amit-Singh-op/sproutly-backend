import { one, q } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { redis } from '../lib/redis.js';

const CACHE_S = 20; // a suspension (or lifting one) takes effect within ~20 s
const key = (userId: string) => `susp:${userId}`;
const DEFAULT_REASON = 'Your account has been suspended for breaking Sproutly’s community rules. If you think this is a mistake, contact support.';

/** Why this account is suspended, or null when it isn't (users.suspended_at / suspended_reason / suspended_until). */
export async function suspensionOf(userId: string): Promise<string | null> {
  const cached = await redis.get(key(userId)).catch(() => null);
  if (cached !== null) return cached === '' ? null : cached;
  const u = await one<{ suspended_at: Date | null; suspended_reason: string | null; suspended_until: Date | null }>(
    'SELECT suspended_at, suspended_reason, suspended_until FROM users WHERE id = $1', [userId],
  );
  // A temporary suspension that has run out lifts itself.
  if (u?.suspended_at && u.suspended_until && u.suspended_until.getTime() <= Date.now()) {
    await q('UPDATE users SET suspended_at = NULL, suspended_reason = NULL, suspended_until = NULL WHERE id = $1 AND suspended_until <= now()', [userId]);
    u.suspended_at = null;
  }
  const reason = u?.suspended_at ? (u.suspended_reason?.trim() || DEFAULT_REASON) : null;
  await redis.set(key(userId), reason ?? '', 'EX', CACHE_S).catch(() => {});
  return reason;
}

/** 403 ACCOUNT_SUSPENDED with the reason: the app signs out and shows it. */
export async function requireNotSuspended(userId: string) {
  const reason = await suspensionOf(userId);
  if (reason) throw new AppError(403, 'ACCOUNT_SUSPENDED', reason);
}
