import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { one, tx } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { AppError } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { dayDiff, localDay, nextLocalMidnight } from '../lib/time.js';
import { DROP_ENERGY, DROP_ODDS, DROP_TRACK_DAYS } from '../shared/rules.js';
import type { DailyDrop, DropClaim, DropRarity } from '../shared/types.js';
import { ensureQuests, grantEnergy } from './companion.js';
import { isPlus } from './entitlements.js';

interface DropRow { day: string; track_day: number; rarity: DropRarity; energy: number }

async function stateFor(userId: string, db?: pg.PoolClient): Promise<{ drop: DailyDrop; today: string }> {
  const tz = (await one<{ timezone: string }>('SELECT timezone FROM users WHERE id = $1', [userId], db))?.timezone ?? 'UTC';
  const today = localDay(tz);
  const last = await one<DropRow>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, track_day, rarity, energy FROM daily_drops WHERE user_id = $1 ORDER BY day DESC LIMIT 1`, [userId], db,
  );
  const claimedToday = last?.day === today;
  // The next claim continues the track if the last one was yesterday (or is today); otherwise it restarts.
  const gap = last ? dayDiff(last.day, today) : Infinity;
  const nextTrack = last && gap <= 1 ? (last.track_day % DROP_TRACK_DAYS) + 1 : 1;
  return {
    today,
    drop: {
      available: !claimedToday, nextAt: nextLocalMidnight(tz), trackDay: nextTrack,
      today: claimedToday ? { energy: last!.energy, rarity: last!.rarity } : null,
    },
  };
}

export async function getDrop(userId: string): Promise<DailyDrop> {
  return (await stateFor(userId)).drop;
}

/** Server-side roll: 70 / 25 / 5, day 7 never common. Energy x2 for Plus, applied like an action. */
export async function claimDrop(userId: string): Promise<DropClaim> {
  const plus = await isPlus(userId);
  const out = await tx(async (c) => {
    // Serialise claims per user.
    await c.query('SELECT 1 FROM companions WHERE user_id = $1 FOR UPDATE', [userId]);
    const { drop, today } = await stateFor(userId, c);
    if (!drop.available) throw new AppError(409, 'ALREADY_CLAIMED', "You've opened today's gift");
    const r = randomInt(1000) / 1000;
    let rarity: DropRarity = r < DROP_ODDS.epic ? 'epic' : r < DROP_ODDS.epic + DROP_ODDS.rare ? 'rare' : 'common';
    if (drop.trackDay === DROP_TRACK_DAYS && rarity === 'common') rarity = 'rare';
    const energy = DROP_ENERGY[rarity] * (plus ? 2 : 1);
    await c.query('INSERT INTO daily_drops (user_id, day, track_day, rarity, energy) VALUES ($1,$2,$3,$4,$5)', [userId, today, drop.trackDay, rarity, energy]);
    const before = (await one<{ level: number }>('SELECT level FROM companions WHERE user_id = $1', [userId], c))!.level;
    const next = await grantEnergy(c, userId, energy);
    const after = await stateFor(userId, c);
    return { drop: after.drop, reward: { energy, rarity }, energy: next.energy, level: next.level, leveledUp: next.level > before, quests: await ensureQuests(userId, c) };
  });
  toUser(userId, 'quest:update', { quests: out.quests, energy: out.energy, level: out.level });
  if (out.leveledUp) await enqueue.push(`level:${userId}:${out.level}`, { kind: 'level', userId, level: out.level });
  const { quests: _q, ...claim } = out;
  return claim;
}
