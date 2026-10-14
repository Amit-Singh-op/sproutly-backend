/**
 * The store-review account (Google Play / App Store reviewers sign in with it). It must see everything, so it always
 * has Plus: granted on every sign-in, and never taken away by subscription updates (it has no real purchase).
 * Matched by the REVIEW_EMAIL setting and, so it works even before that's configured, the known review address.
 */
import { config } from '../config.js';
import { q, tx, type Db } from '../db/pool.js';

const KNOWN_REVIEW_LOGINS = ['playreview@sproutly.app'];

const reviewLogins = () => new Set([config.REVIEW_EMAIL, ...KNOWN_REVIEW_LOGINS].filter((e): e is string => !!e).map((e) => e.trim().toLowerCase()));

export function isReviewLogin(login: string | null | undefined): boolean {
  return !!login && reviewLogins().has(login.trim().toLowerCase());
}

/** Gives the review account active yearly Plus (and approval). Idempotent; safe to call on every sign-in. */
export async function ensureReviewPlus(userId: string, db?: Db) {
  const run = async (c: Db) => {
    await q(
      `INSERT INTO subscriptions (user_id, product_id, status, period, trial, current_period_end, plus_since, store, will_renew, updated_at)
       VALUES ($1, 'review_plus', 'active', 'yearly', FALSE, now() + interval '10 years', now(), 'review', TRUE, now())
       ON CONFLICT (user_id) DO UPDATE SET status = 'active', period = 'yearly',
         current_period_end = GREATEST(COALESCE(subscriptions.current_period_end, now()), now() + interval '1 year'),
         plus_since = COALESCE(subscriptions.plus_since, now()), billing_issue_at = NULL, updated_at = now()`,
      [userId], c,
    );
    await q(
      `INSERT INTO entitlements (user_id, plus_active, updated_at) VALUES ($1, TRUE, now())
       ON CONFLICT (user_id) DO UPDATE SET plus_active = TRUE, updated_at = now()`,
      [userId], c,
    );
    await q(`UPDATE users SET approved = TRUE, approved_at = COALESCE(approved_at, now()) WHERE id = $1`, [userId], c);
  };
  if (db) await run(db); else await tx(run);
}

/**
 * Moderators (ADMIN_EMAILS) have Plus while they're moderators: a 30-day staff subscription, topped up whenever their
 * app loads their profile. Taken off the list, it simply runs out (the hourly expiry job ends it). Idempotent.
 */
export async function ensureAdminPlus(userId: string) {
  await tx(async (c) => {
    await q(
      `INSERT INTO subscriptions (user_id, product_id, status, period, trial, current_period_end, plus_since, store, will_renew, updated_at)
       VALUES ($1, 'admin_plus', 'active', 'monthly', FALSE, now() + interval '30 days', now(), 'staff', FALSE, now())
       ON CONFLICT (user_id) DO UPDATE SET status = 'active',
         product_id = CASE WHEN subscriptions.store IN ('staff', 'review') OR subscriptions.current_period_end IS NULL OR subscriptions.current_period_end < now() THEN 'admin_plus' ELSE subscriptions.product_id END,
         store = CASE WHEN subscriptions.store IN ('staff', 'review') OR subscriptions.current_period_end IS NULL OR subscriptions.current_period_end < now() THEN 'staff' ELSE subscriptions.store END,
         current_period_end = GREATEST(COALESCE(subscriptions.current_period_end, now()), now() + interval '30 days'),
         plus_since = COALESCE(subscriptions.plus_since, now()), billing_issue_at = NULL, updated_at = now()`,
      [userId], c,
    );
    await q(
      `INSERT INTO entitlements (user_id, plus_active, updated_at) VALUES ($1, TRUE, now())
       ON CONFLICT (user_id) DO UPDATE SET plus_active = TRUE, updated_at = now()`,
      [userId], c,
    );
  });
}
