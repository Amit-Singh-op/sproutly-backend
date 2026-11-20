import { config } from '../config.js';
import { one } from '../db/pool.js';
import { log } from '../lib/log.js';
import { enqueue } from '../lib/queues.js';
import { AppError } from '../lib/errors.js';
import { redis } from '../lib/redis.js';
import { getAppConfig } from './appConfig.js';
import { normalizeLogin } from './auth.js';
import { isAdminLogin } from './moderation.js';

const CACHE_S = 20; // an admin's approval shows up within ~20 s
const key = (userId: string) => `appr:${userId}`;

/**
 * Invite-only gate. A user may use the app when approval isn't required (app_config.approval_required = false),
 * when an admin set users.approved = true, when it's the store-review account (reviewers must get in), or when it's a
 * moderator's account (ADMIN_EMAILS).
 */
export async function isApproved(userId: string): Promise<boolean> {
  if (!(await getAppConfig()).approvalRequired) return true;
  const cached = await redis.get(key(userId)).catch(() => null);
  if (cached !== null) return cached === '1';
  const u = await one<{ approved: boolean; login: string }>('SELECT approved, login FROM users WHERE id = $1', [userId]);
  const review = !!u && !!config.REVIEW_EMAIL && u.login === normalizeLogin(config.REVIEW_EMAIL);
  // Moderators (ADMIN_EMAILS) never wait for approval.
  const ok = !!u && (u.approved || review || isAdminLogin(u.login));
  await redis.set(key(userId), ok ? '1' : '0', 'EX', CACHE_S).catch(() => {});
  return ok;
}

export async function requireApproved(userId: string) {
  if (!(await isApproved(userId))) {
    throw new AppError(403, 'APPROVAL_PENDING', 'Your account is waiting for approval.');
  }
}

/** Would this new account have to wait for approval? (Not the store-review account or a moderator.) */
export async function needsApproval(login: string): Promise<boolean> {
  if (!(await getAppConfig()).approvalRequired) return false;
  const review = !!config.REVIEW_EMAIL && login === normalizeLogin(config.REVIEW_EMAIL);
  return !review && !isAdminLogin(login);
}

/**
 * Lets someone in: they can use the app straight away (the cached answer is dropped) and get a push saying so.
 * 'already' if they were approved before, 'missing' if the account no longer exists.
 */
export async function approveUser(userId: string): Promise<'approved' | 'already' | 'missing'> {
  const done = await one('UPDATE users SET approved = TRUE, approved_at = now() WHERE id = $1 AND NOT approved RETURNING id', [userId]);
  if (!done) return (await one('SELECT 1 FROM users WHERE id = $1', [userId])) ? 'already' : 'missing';
  await redis.del(key(userId)).catch(() => {});
  enqueue.push(`approved:${userId}`, {
    kind: 'social', userId, title: 'You’re in! 🌱', body: 'Your Sproutly account is approved. Come say hi to your sprout.', data: { type: 'approved' },
  }).catch((err: unknown) => log.warn({ err: (err as Error).message }, 'approved push enqueue failed'));
  return 'approved';
}
