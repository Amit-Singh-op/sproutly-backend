import { one } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { redis } from '../lib/redis.js';

const CACHE_S = 20; // a suspension (or lifting one) takes effect within ~20 s
const key = (userId: string) => `susp:${userId}`;
const DEFAULT_REASON = 'Your account has been suspended for breaking Sproutly’s community rules. If you think this is a mistake, contact support.';

/** Why this account is suspended, or null when it isn't (set by an admin: users.suspended_at / suspended_reason). */
export async function suspensionOf(userId: string): Promise<string | null> {
  const cached = await redis.get(key(userId)).catch(() => null);
  if (cached !== null) return cached === '' ? null : cached;
  const u = await one<{ suspended_at: Date | null; suspended_reason: string | null }>(
    'SELECT suspended_at, suspended_reason FROM users WHERE id = $1', [userId],
  );
  const reason = u?.suspended_at ? (u.suspended_reason?.trim() || DEFAULT_REASON) : null;
  await redis.set(key(userId), reason ?? '', 'EX', CACHE_S).catch(() => {});
  return reason;
}

/** 403 ACCOUNT_SUSPENDED with the reason: the app signs out and shows it. */
export async function requireNotSuspended(userId: string) {
  const reason = await suspensionOf(userId);
  if (reason) throw new AppError(403, 'ACCOUNT_SUSPENDED', reason);
}
