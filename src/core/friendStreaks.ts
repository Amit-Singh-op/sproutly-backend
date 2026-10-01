import { one, tx } from '../db/pool.js';
import { FRIEND_STREAK_MILESTONES, friendStreakStep, utcDay, type FriendStreakRow } from '../shared/retention.js';
import { notifyActivity } from './activity.js';

/**
 * A DM message from `senderId` to `otherId` today (UTC, so both people share the same day boundary).
 * The pair's streak grows once per day, when both have messaged. Milestones land in both activity feeds.
 */
export async function recordDmMessage(senderId: string, otherId: string, at: Date = new Date()) {
  if (senderId === otherId) return;
  const [a, b] = senderId < otherId ? [senderId, otherId] : [otherId, senderId];
  const side: 'a' | 'b' = senderId === a ? 'a' : 'b';
  const today = utcDay(at);
  const out = await tx(async (c) => {
    await c.query('INSERT INTO friend_streaks (user_a, user_b) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a, b]);
    const row = (await one<{ count: number; last_day: string | null; a_day: string | null; b_day: string | null }>(
      'SELECT count, last_day, a_day, b_day FROM friend_streaks WHERE user_a = $1 AND user_b = $2 FOR UPDATE', [a, b], c,
    ))!;
    const prev: FriendStreakRow = { count: row.count, lastDay: row.last_day, aDay: row.a_day, bDay: row.b_day };
    const next = friendStreakStep(prev, side, today);
    if (next.aDay === prev.aDay && next.bDay === prev.bDay && !next.extended) return null; // already counted today
    await c.query(
      `UPDATE friend_streaks SET count = $3, last_day = $4, a_day = $5, b_day = $6, best = GREATEST(best, $3), updated_at = now()
        WHERE user_a = $1 AND user_b = $2`,
      [a, b, next.count, next.lastDay, next.aDay, next.bDay],
    );
    return next;
  });
  if (out?.extended && FRIEND_STREAK_MILESTONES.includes(out.count)) {
    await notifyActivity([a], b, 'friend_streak', { count: out.count }, `fstreak:${b}:${out.count}:${today}`);
    await notifyActivity([b], a, 'friend_streak', { count: out.count }, `fstreak:${a}:${out.count}:${today}`);
  }
}
