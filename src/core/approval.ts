import { config } from '../config.js';
import { one } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { redis } from '../lib/redis.js';
import { getAppConfig } from './appConfig.js';
import { normalizeLogin } from './auth.js';

const CACHE_S = 20; // an admin's approval shows up within ~20 s
const key = (userId: string) => `appr:${userId}`;

/**
 * Invite-only gate. A user may use the app when approval isn't required (app_config.approval_required = false),
 * when an admin set users.approved = true, or when it's the store-review account (reviewers must get in).
 */
export async function isApproved(userId: string): Promise<boolean> {
  if (!(await getAppConfig()).approvalRequired) return true;
  const cached = await redis.get(key(userId)).catch(() => null);
  if (cached !== null) return cached === '1';
  const u = await one<{ approved: boolean; login: string }>('SELECT approved, login FROM users WHERE id = $1', [userId]);
  const review = !!u && !!config.REVIEW_EMAIL && u.login === normalizeLogin(config.REVIEW_EMAIL);
  const ok = !!u && (u.approved || review);
  await redis.set(key(userId), ok ? '1' : '0', 'EX', CACHE_S).catch(() => {});
  return ok;
}

export async function requireApproved(userId: string) {
  if (!(await isApproved(userId))) {
    throw new AppError(403, 'APPROVAL_PENDING', 'Your account is waiting for approval.');
  }
}
