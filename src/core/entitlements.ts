import { one, q, tx, type Db } from '../db/pool.js';
import { toUser, toUsers } from '../lib/emitter.js';
import { E } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { redis } from '../lib/redis.js';
import { isPlusMove, isPlusOutfit, isPlusPalette } from '../shared/rules.js';
import type { Entitlements } from '../shared/types.js';
import { peersOf, userStyleOf } from './users.js';
import { isReviewLogin } from './review.js';

const cacheKey = (userId: string) => `ent:${userId}`;

/** Doc section 4: read entitlements.plus_active, cached in Redis for 60 s. */
export async function isPlus(userId: string): Promise<boolean> {
  const cached = await redis.get(cacheKey(userId));
  if (cached !== null) return cached === '1';
  const row = await one<{ plus_active: boolean }>('SELECT plus_active FROM entitlements WHERE user_id = $1', [userId]);
  const plus = !!row?.plus_active;
  await redis.set(cacheKey(userId), plus ? '1' : '0', 'EX', 60);
  return plus;
}

export async function requirePlus(userId: string, feature: string) {
  if (!(await isPlus(userId))) throw E.plusRequired(feature);
}

export async function invalidatePlus(userId: string) {
  await redis.del(cacheKey(userId));
}

export async function getEntitlements(userId: string, db: Db = undefined as never): Promise<Entitlements> {
  const r = await one<{ plus_active: boolean; period: 'monthly' | 'yearly' | null; current_period_end: Date | null; plus_since: Date | null }>(
    `SELECT e.plus_active, s.period, s.current_period_end, s.plus_since
       FROM entitlements e LEFT JOIN subscriptions s ON s.user_id = e.user_id WHERE e.user_id = $1`,
    [userId], db,
  );
  return {
    plusActive: !!r?.plus_active,
    period: r?.plus_active ? r.period ?? null : null,
    currentPeriodEnd: r?.plus_active ? r.current_period_end?.toISOString() ?? null : null,
    plusSince: r?.plus_active ? r.plus_since?.toISOString() ?? null : null,
  };
}

export interface SubscriptionState {
  active: boolean;
  productId: string | null;
  period: 'monthly' | 'yearly' | null;
  status: string;
  trial: boolean;
  currentPeriodEnd: Date | null;
  willRenew: boolean;
  billingIssueAt: Date | null;
  store: string | null;
  purchasedAt: Date | null;
}

/**
 * The single write path for payment state (webhook, purchase sync, transfer).
 * Ignores state older than what we already applied (RevenueCat may deliver out of order).
 * Returns true when plus_active changed.
 */
export async function applySubscription(userId: string, s: SubscriptionState, eventMs: number): Promise<boolean> {
  // The store-review account keeps Plus whatever the store says (it has no real purchase to report).
  if (!s.active) {
    const u = await one<{ login: string }>('SELECT login FROM users WHERE id = $1', [userId]);
    if (isReviewLogin(u?.login)) return false;
  }
  const changed = await tx(async (c) => {
    const cur = await one<{ last_event_ms: number; plus_active: boolean }>(
      `SELECT COALESCE(s.last_event_ms, 0) AS last_event_ms, COALESCE(e.plus_active, FALSE) AS plus_active
         FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id LEFT JOIN entitlements e ON e.user_id = u.id
        WHERE u.id = $1 FOR UPDATE OF u`,
      [userId], c,
    );
    if (!cur) throw E.notFound('User not found');
    if (eventMs < cur.last_event_ms) return false;

    await q(
      `INSERT INTO subscriptions (user_id, product_id, status, period, trial, current_period_end, plus_since, store, will_renew, billing_issue_at, last_event_ms, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (user_id) DO UPDATE SET
         product_id = EXCLUDED.product_id, status = EXCLUDED.status, period = EXCLUDED.period, trial = EXCLUDED.trial,
         current_period_end = EXCLUDED.current_period_end,
         plus_since = CASE WHEN EXCLUDED.status = 'expired' THEN NULL ELSE COALESCE(subscriptions.plus_since, EXCLUDED.plus_since) END,
         store = COALESCE(EXCLUDED.store, subscriptions.store), will_renew = EXCLUDED.will_renew,
         billing_issue_at = EXCLUDED.billing_issue_at, last_event_ms = EXCLUDED.last_event_ms, updated_at = now()`,
      [userId, s.productId, s.status, s.period, s.trial, s.currentPeriodEnd, s.active ? (s.purchasedAt ?? new Date()) : null,
        s.store, s.willRenew, s.billingIssueAt, eventMs],
      c,
    );
    await q(
      `INSERT INTO entitlements (user_id, plus_active, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE SET plus_active = EXCLUDED.plus_active, updated_at = now()`,
      [userId, s.active], c,
    );
    if (s.active) {
      await q(`UPDATE users SET approved = TRUE, approved_at = COALESCE(approved_at, now()) WHERE id = $1`, [userId], c);
    }
    return cur.plus_active !== s.active;
  });

  await invalidatePlus(userId);
  toUser(userId, 'me:entitlements', await getEntitlements(userId));
  if (changed) await enqueue.entitlement(`ent:${userId}:${eventMs}:${s.active ? 'up' : 'down'}`, { userId, reason: s.active ? 'upgrade' : 'downgrade' });
  return changed;
}

/**
 * Doc section 4 "Downgrade" (and its inverse on upgrade). Runs in the entitlement-sync worker; safe to run twice.
 * - downgrade: Plus character -> mo, Plus outfit -> none, Plus move -> wave, read_only in Plus-only groups, style stops applying.
 * - upgrade: lift read_only in Plus-only groups.
 * Both broadcast style:update to everyone who shares a conversation with the user.
 */
export async function applyPlusChange(userId: string, reason: 'upgrade' | 'downgrade') {
  if (reason === 'downgrade' && (await isPlus(userId))) return; // re-subscribed since the job was queued
  await tx(async (c) => {
    if (reason === 'downgrade') {
      const comp = await one<{ palette: string; equipped_outfit: string; signature_move: string }>('SELECT palette, equipped_outfit, signature_move FROM companions WHERE user_id = $1', [userId], c);
      if (comp) {
        await q(
          `UPDATE companions SET palette = $4, equipped_outfit = $2, signature_move = $3, room_theme = 'basic', updated_at = now() WHERE user_id = $1`,
          [userId, isPlusOutfit(comp.equipped_outfit) ? 'none' : comp.equipped_outfit, isPlusMove(comp.signature_move) ? 'wave' : comp.signature_move,
            isPlusPalette(comp.palette) ? 'mo' : comp.palette], c,
        );
      }
      await q(
        `UPDATE conversation_members m SET read_only = TRUE FROM conversations c
          WHERE c.id = m.conversation_id AND c.plus_only AND m.user_id = $1`, [userId], c,
      );
    } else {
      await q(
        `UPDATE conversation_members m SET read_only = FALSE FROM conversations c
          WHERE c.id = m.conversation_id AND c.plus_only AND m.user_id = $1`, [userId], c,
      );
    }
  });
  const style = await userStyleOf(userId);
  if (style) {
    const peers = await peersOf(userId);
    toUsers([...peers, userId], 'style:update', style);
  }
}
