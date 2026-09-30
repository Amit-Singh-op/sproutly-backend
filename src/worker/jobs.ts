import { recordMessageSent } from '../core/companion.js';
import { applyPlusChange, applySubscription } from '../core/entitlements.js';
import { one, q, tx } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { log } from '../lib/log.js';
import type { EntitlementJob, FanoutJob, QuestJob } from '../lib/queues.js';
import { dayDiff, localDay } from '../lib/time.js';
import { LIMITS, MESSAGE_RETENTION_DAYS, applyEnergy } from '../shared/rules.js';

export async function handleQuest(job: QuestJob) {
  if (job.kind === 'message.sent') {
    const m = await one<{ sender_id: string | null; conversation_id: string; type: string }>('SELECT sender_id, conversation_id, type FROM messages WHERE id = $1', [job.messageId]);
    if (!m?.sender_id || m.type === 'system') return;
    // "Say hi to 3 friends": every other member of the chat is a recipient.
    const recipients = await q<{ user_id: string }>('SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2', [m.conversation_id, m.sender_id]);
    await recordMessageSent(m.sender_id, recipients.map((r) => r.user_id));
    return;
  }
  // room.visit: the owner's companion gets +5 energy (x2 Plus) for each daily visitor cheer.
  const plus = !!(await one<{ plus_active: boolean }>('SELECT plus_active FROM entitlements WHERE user_id = $1', [job.ownerId]))?.plus_active;
  const next = await tx(async (c) => {
    const comp = await one<{ level: number; energy: number }>('SELECT level, energy FROM companions WHERE user_id = $1 FOR UPDATE', [job.ownerId], c);
    if (!comp) return null;
    const n = applyEnergy(comp.level, comp.energy, plus ? 10 : 5);
    await q('UPDATE companions SET level = $2, energy = $3 WHERE user_id = $1', [job.ownerId, n.level, n.energy], c);
    return n;
  });
  if (next) {
    const quests = await q<{ quest_key: string; title: string; reward: number; target: number; progress: number; completed_at: Date | null }>(
      'SELECT * FROM quests_daily WHERE user_id = $1 AND day = (SELECT max(day) FROM quests_daily WHERE user_id = $1) ORDER BY reward', [job.ownerId],
    );
    toUser(job.ownerId, 'quest:update', {
      quests: quests.map((r) => ({ key: r.quest_key, title: r.title, reward: r.reward, target: r.target, progress: Math.min(r.progress, r.target), done: !!r.completed_at })),
      energy: next.energy, level: next.level,
    });
  }
}

/** Insert showcase_feed rows for the author's friends (cap 5000; above that, feeds are built on read). */
export async function handleFanout(job: FanoutJob) {
  const p = await one<{ user_id: string; created_at: Date }>('SELECT user_id, created_at FROM showcase_posts WHERE id = $1', [job.postId]);
  if (!p) return;
  const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM friendships WHERE friend_id = $1 AND status = 'accepted'`, [p.user_id]);
  if ((n?.n ?? 0) > LIMITS.feedFanoutCap) return;
  await q(
    `INSERT INTO showcase_feed (user_id, post_id, created_at)
     SELECT user_id, $2, $3 FROM friendships WHERE friend_id = $1 AND status = 'accepted'
     ON CONFLICT DO NOTHING`, [p.user_id, job.postId, p.created_at],
  );
}

export async function handleEntitlement(job: EntitlementJob) {
  await applyPlusChange(job.userId, job.reason);
}

// ---------------- maintenance (cron) ----------------
/** Mon 00:00 UTC: the most-cheered post of the last 7 days gets the "Top companion this week" ribbon. */
export async function weeklyTop() {
  await q(
    `INSERT INTO weekly_top (week_start, post_id)
     SELECT date_trunc('week', now())::date, p.id FROM showcase_posts p
      WHERE NOT p.hidden AND p.created_at > now() - interval '7 days'
      ORDER BY p.cheer_count DESC, p.created_at ASC LIMIT 1
     ON CONFLICT (week_start) DO UPDATE SET post_id = EXCLUDED.post_id`,
  );
}

/**
 * Hourly: at each timezone's local midnight, streaks that can no longer continue drop to 0
 * (the next action starts at 1). A Plus user with exactly one missed day and an unused 7-day shield keeps theirs.
 */
export async function streakResets() {
  const rows = await q<{ user_id: string; timezone: string; last_active_day: string; shield_used_at: string | null; plus: boolean }>(
    `SELECT c.user_id, u.timezone, c.last_active_day, c.shield_used_at, COALESCE(e.plus_active, FALSE) AS plus
       FROM companions c JOIN users u ON u.id = c.user_id LEFT JOIN entitlements e ON e.user_id = c.user_id
      WHERE c.streak > 0 AND c.last_active_day IS NOT NULL AND c.last_active_day < (now() AT TIME ZONE 'UTC')::date + 1`,
  );
  let reset = 0;
  for (const r of rows) {
    const gap = dayDiff(r.last_active_day, localDay(r.timezone));
    const shieldReady = !r.shield_used_at || dayDiff(r.shield_used_at, localDay(r.timezone)) >= 7;
    const alive = gap <= 1 || (gap === 2 && r.plus && shieldReady);
    if (!alive) { await q('UPDATE companions SET streak = 0 WHERE user_id = $1', [r.user_id]); reset++; }
  }
  if (reset) log.info({ reset }, 'streaks reset');
}

/** Hourly safety net: if an EXPIRATION webhook was lost, end Plus a day after the paid period (+ grace) ran out. */
export async function expireLapsedSubscriptions() {
  const rows = await q<{ user_id: string; product_id: string | null; period: 'monthly' | 'yearly' | null; store: string | null }>(
    `SELECT s.user_id, s.product_id, s.period, s.store FROM subscriptions s JOIN entitlements e ON e.user_id = s.user_id
      WHERE e.plus_active AND s.current_period_end IS NOT NULL AND s.current_period_end < now() - interval '1 day'
        AND s.status <> 'billing_issue'`,
  );
  for (const r of rows) {
    await applySubscription(r.user_id, {
      active: false, productId: r.product_id, period: r.period, status: 'expired', trial: false, currentPeriodEnd: null,
      willRenew: false, billingIssueAt: null, store: r.store, purchasedAt: null,
    }, Date.now());
  }
  if (rows.length) log.warn({ n: rows.length }, 'expired subscriptions without a webhook');
}

/** Daily: drop webhook ids older than 30 days, expired OTPs, dead refresh tokens, old typing/viewing debris is TTL'd in Redis. */
/**
 * Hourly: permanently delete every message older than MESSAGE_RETENTION_DAYS (DMs and groups), in batches so the
 * table is never locked for long; poll votes go with them (ON DELETE CASCADE). Also drops expired stories.
 */
export async function purgeOldMessages() {
  let total = 0;
  for (;;) {
    const r = await q<{ id: string }>(
      `DELETE FROM messages WHERE id IN (
         SELECT id FROM messages WHERE created_at < now() - make_interval(days => $1) LIMIT 5000
       ) RETURNING id`, [MESSAGE_RETENTION_DAYS],
    );
    total += r.length;
    if (r.length < 5000) break;
  }
  const stories = await q<{ id: string }>(`DELETE FROM stories WHERE expires_at < now() RETURNING id`);
  if (total || stories.length) log.info({ messages: total, stories: stories.length }, 'retention purge');
}

export async function cleanup() {
  await q(`DELETE FROM webhook_events WHERE received_at < now() - interval '30 days'`);
  await q(`DELETE FROM otp_codes WHERE expires_at < now()`);
  await q(`DELETE FROM refresh_tokens WHERE expires_at < now() OR revoked_at < now() - interval '7 days'`);
  await q(`DELETE FROM showcase_feed WHERE created_at < now() - interval '14 days'`);
}
