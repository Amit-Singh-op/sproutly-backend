import { one, q, tx } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { AppError } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { QUEST_CHEST, addDays, chestReady } from '../shared/retention.js';
import type { QuestChest, QuestChestClaim, WeeklyRecap } from '../shared/types.js';
import { ensureQuests, grantEnergy, userDay } from './companion.js';
import { adjustCoinsTx } from './ledger.js';

export async function getChest(userId: string): Promise<QuestChest> {
  const day = await userDay(userId);
  const quests = await ensureQuests(userId);
  const claimed = !!(await one('SELECT 1 FROM quest_chests WHERE user_id = $1 AND day = $2', [userId, day]));
  return { day, ready: chestReady(quests) && !claimed, claimed, done: quests.filter((x) => x.done).length, total: quests.length, reward: { ...QUEST_CHEST } };
}

/** Once per local day, only when every quest of that day is done. */
export async function claimChest(userId: string): Promise<QuestChestClaim> {
  const out = await tx(async (c) => {
    const comp = await one<{ level: number }>('SELECT level FROM companions WHERE user_id = $1 FOR UPDATE', [userId], c);
    const day = await userDay(userId, c);
    const quests = await ensureQuests(userId, c);
    if (!chestReady(quests)) throw new AppError(409, 'CHEST_LOCKED', 'Finish all of today’s quests first');
    const ins = await c.query('INSERT INTO quest_chests (user_id, day, coins, energy) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [userId, day, QUEST_CHEST.coins, QUEST_CHEST.energy]);
    if ((ins.rowCount ?? 0) === 0) throw new AppError(409, 'CHEST_CLAIMED', 'You already opened today’s chest');
    const wallet = await adjustCoinsTx(c, userId, QUEST_CHEST.coins, 'quest_chest', `chest:${day}`);
    const next = await grantEnergy(c, userId, QUEST_CHEST.energy);
    return {
      chest: { day, ready: false, claimed: true, done: quests.length, total: quests.length, reward: { ...QUEST_CHEST } },
      coins: wallet.coins, energy: next.energy, level: next.level, leveledUp: next.level > comp!.level,
    };
  });
  toUser(userId, 'wallet:update', { coins: out.coins });
  if (out.leveledUp) await enqueue.push(`level:${userId}:${out.level}`, { kind: 'level', userId, level: out.level });
  return out;
}

/** The last 7 local days, from data we already keep (actions, ledger, activity, chat streaks). */
export async function weeklyRecap(userId: string): Promise<WeeklyRecap> {
  const to = await userDay(userId);
  const from = addDays(to, -6);
  const [acts, coins, feed, fs, comp] = await Promise.all([
    one<{ days: number; energy: number }>(
      'SELECT count(DISTINCT day)::int AS days, COALESCE(sum(gain), 0)::int AS energy FROM companion_actions WHERE user_id = $1 AND day BETWEEN $2 AND $3', [userId, from, to]),
    one<{ n: number }>(
      `SELECT COALESCE(sum(amount), 0)::int AS n FROM coin_transactions WHERE user_id = $1 AND amount > 0 AND created_at > now() - interval '7 days'`, [userId]),
    q<{ kind: string; n: number }>(
      `SELECT kind, count(*)::int AS n FROM activity WHERE user_id = $1 AND kind IN ('room_visit','guestbook') AND created_at > now() - interval '7 days' GROUP BY kind`, [userId]),
    one<{ best: number }>(
      `SELECT COALESCE(max(count), 0)::int AS best FROM friend_streaks WHERE (user_a = $1 OR user_b = $1) AND last_day >= (now() AT TIME ZONE 'UTC')::date - 1`, [userId]),
    one<{ streak: number }>('SELECT streak FROM companions WHERE user_id = $1', [userId]),
  ]);
  const by = new Map(feed.map((r) => [r.kind, r.n]));
  return {
    from, to, daysWithCompanion: acts?.days ?? 0, energyEarned: acts?.energy ?? 0, coinsEarned: coins?.n ?? 0,
    friendVisits: by.get('room_visit') ?? 0, guestbookNotes: by.get('guestbook') ?? 0, chatStreakBest: fs?.best ?? 0, streak: comp?.streak ?? 0,
  };
}

/** Every level-up pays coins (from the level job, so each level pays exactly once). */
export async function payLevelCoins(userId: string, level: number, coins: number) {
  const r = await tx((c) => adjustCoinsTx(c, userId, coins, 'level_up', `level:${level}`));
  if (r.applied) toUser(userId, 'wallet:update', { coins: r.coins });
}
