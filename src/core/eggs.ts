import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { one, q, tx, type Db } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { AppError } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { localDay } from '../lib/time.js';
import { EGG_DAYS, rollEggReward } from '../shared/retention.js';
import type { Egg, EggHatch } from '../shared/types.js';
import { grantEnergy } from './companion.js';
import { grantInventoryItemTx } from './inventory.js';
import { adjustCoinsTx } from './ledger.js';

interface EggRow { id: string; source: Egg['source']; target: number; progress: number; last_warm_day: string | null }

const toEgg = (r: EggRow, today: string): Egg => ({
  id: r.id, source: r.source, target: r.target, progress: Math.min(r.progress, r.target),
  warmedToday: r.last_warm_day === today, ready: r.progress >= r.target,
});

async function todayFor(userId: string, db?: Db) {
  return localDay((await one<{ timezone: string }>('SELECT timezone FROM users WHERE id = $1', [userId], db))?.timezone ?? 'UTC');
}

const incubating = (userId: string, db: Db, lock = false) => one<EggRow>(
  `SELECT id, source, target, progress, to_char(last_warm_day, 'YYYY-MM-DD') AS last_warm_day FROM eggs
    WHERE user_id = $1 AND hatched_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [userId], db,
);

/** Start an egg unless one is already incubating. Returns whether one was started. */
export async function startEgg(c: pg.PoolClient, userId: string, source: Egg['source']): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO eggs (user_id, source, target) VALUES ($1, $2, $3) ON CONFLICT (user_id) WHERE hatched_at IS NULL DO NOTHING`,
    [userId, source, EGG_DAYS],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Everyone gets one starter egg (new and existing accounts alike) the first time they look. */
async function ensureStarterEgg(c: pg.PoolClient, userId: string) {
  const any = await one('SELECT 1 FROM eggs WHERE user_id = $1 LIMIT 1', [userId], c);
  if (!any) await startEgg(c, userId, 'starter');
}

export async function getEgg(userId: string): Promise<Egg | null> {
  return tx(async (c) => {
    await ensureStarterEgg(c, userId);
    const r = await incubating(userId, c);
    return r ? toEgg(r, await todayFor(userId, c)) : null;
  });
}

/** Called from a companion action (inside its transaction): warms the egg once per local day. */
export async function warmEgg(c: pg.PoolClient, userId: string, day: string): Promise<Egg | null> {
  await ensureStarterEgg(c, userId);
  const r = await incubating(userId, c, true);
  if (!r) return null;
  if (r.last_warm_day !== day && r.progress < r.target) {
    await c.query('UPDATE eggs SET progress = progress + 1, last_warm_day = $2 WHERE id = $1', [r.id, day]);
    return toEgg({ ...r, progress: r.progress + 1, last_warm_day: day }, day);
  }
  return toEgg(r, day);
}

/** Hatch a ready egg: coins or an unowned wearable, plus some energy. */
export async function hatchEgg(userId: string): Promise<EggHatch> {
  const out = await tx(async (c) => {
    const r = await incubating(userId, c, true);
    if (!r) throw new AppError(404, 'NO_EGG', "You don't have an egg right now");
    if (r.progress < r.target) throw new AppError(409, 'EGG_NOT_READY', `Your egg needs ${r.target - r.progress} more day${r.target - r.progress === 1 ? '' : 's'}`);
    const owned = new Set((await q<{ item_id: string }>('SELECT item_id FROM user_inventory WHERE user_id = $1', [userId], c)).map((x) => x.item_id));
    const reward = rollEggReward(() => randomInt(1_000_000) / 1_000_000, owned);
    const comp = (await one<{ level: number; coins: number }>('SELECT level, coins FROM companions WHERE user_id = $1', [userId], c))!;
    let coins = comp.coins;
    if (reward.coins > 0) coins = (await adjustCoinsTx(c, userId, reward.coins, 'egg', `egg:${r.id}`)).coins;
    if (reward.itemId) await grantInventoryItemTx(c, userId, reward.itemId, 'egg');
    const next = await grantEnergy(c, userId, reward.energy);
    await c.query('UPDATE eggs SET hatched_at = now(), reward = $2 WHERE id = $1', [r.id, JSON.stringify(reward)]);
    return { reward, energy: next.energy, level: next.level, leveledUp: next.level > comp.level, coins };
  });
  toUser(userId, 'wallet:update', { coins: out.coins });
  if (out.leveledUp) await enqueue.push(`level:${userId}:${out.level}`, { kind: 'level', userId, level: out.level });
  return out;
}
