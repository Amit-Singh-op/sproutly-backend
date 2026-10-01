import type pg from 'pg';
import { one, q, tx } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { log } from '../lib/log.js';
import { E } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { dayDiff, localDay } from '../lib/time.js';
import { applyEnergy, isPlusMove, isPlusPalette } from '../shared/rules.js';
import { COMEBACK_BONUS, MAX_SHIELDS, isComeback, milestoneAt, socialQuestFor, streakAfterGap, type SocialQuestKey } from '../shared/retention.js';
import type { Egg, StreakMilestoneReward } from '../shared/types.js';
import { notifyFriends } from './activity.js';
import { warmEgg } from './eggs.js';
import { getCatalogItem } from '../shared/catalog.js';
import { grantInventoryItemTx } from './inventory.js';
import { adjustCoinsTx } from './ledger.js';
import { ACTION_RULES, type ActionResult, type Companion, type CompanionAction, type EquippedSlots, type Mood, type Outfit, type PaletteId, type Quest } from '../shared/types.js';
import { slotOfOutfit } from '../shared/catalog.js';
import { isPlus, requirePlus } from './entitlements.js';
import { equipSlots } from './inventory.js';
import { companionFromRow, getCompanion, peersOf, userStyleOf } from './users.js';
import { toUsers } from '../lib/emitter.js';

/** Daily quests (doc section 7). Rewards are doubled for Plus when granted. One social quest rotates in each day. */
const QUEST_DEFS = (name: string, day: string) => [
  { key: 'pet', title: `Pet ${name}`, target: 1, reward: 5 },
  { key: 'feed', title: `Feed ${name} a snack`, target: 1, reward: 10 },
  { key: 'hi3', title: 'Say hi to 3 friends', target: 3, reward: 30 },
  socialQuestFor(day),
];

interface QuestRow { quest_key: string; title: string; target: number; progress: number; reward: number; completed_at: Date | null }
const questFromRow = (r: QuestRow): Quest => ({ key: r.quest_key, title: r.title, reward: r.reward, target: r.target, progress: Math.min(r.progress, r.target), done: !!r.completed_at });

export async function userDay(userId: string, db?: pg.PoolClient) {
  const u = await one<{ timezone: string }>('SELECT timezone FROM users WHERE id = $1', [userId], db);
  return localDay(u?.timezone ?? 'UTC');
}

/** Today's quests in the user's timezone; created lazily at their first request after local midnight. */
export async function ensureQuests(userId: string, db?: pg.PoolClient): Promise<Quest[]> {
  const day = await userDay(userId, db);
  let rows = await q<QuestRow>('SELECT * FROM quests_daily WHERE user_id = $1 AND day = $2 ORDER BY reward', [userId, day], db);
  if (rows.length === 0) {
    const name = (await one<{ name: string }>('SELECT name FROM companions WHERE user_id = $1', [userId], db))?.name ?? 'Mo';
    for (const d of QUEST_DEFS(name, day)) {
      await q(
        `INSERT INTO quests_daily (user_id, day, quest_key, title, target, reward) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [userId, day, d.key, d.title, d.target, d.reward], db,
      );
    }
    rows = await q<QuestRow>('SELECT * FROM quests_daily WHERE user_id = $1 AND day = $2 ORDER BY reward', [userId, day], db);
  }
  return rows.map(questFromRow);
}

/**
 * Advance a quest. Completing it grants its reward (x2 Plus) exactly once.
 * `uniqueKey` (e.g. a recipient id) makes progress count unique values only.
 * Returns the energy granted (0 if nothing completed).
 */
async function progressQuest(c: pg.PoolClient, userId: string, key: string, plus: boolean, uniqueKey?: string): Promise<number> {
  const day = await userDay(userId, c);
  await ensureQuests(userId, c);
  const row = await one<QuestRow & { meta: { seen?: string[] } }>(
    'SELECT * FROM quests_daily WHERE user_id = $1 AND day = $2 AND quest_key = $3 FOR UPDATE', [userId, day, key], c,
  );
  if (!row || row.completed_at) return 0;
  let progress = row.progress + 1;
  let meta = row.meta ?? {};
  if (uniqueKey) {
    const seen = new Set(meta.seen ?? []);
    if (seen.has(uniqueKey)) return 0;
    seen.add(uniqueKey);
    meta = { ...meta, seen: [...seen] };
    progress = seen.size;
  }
  const done = progress >= row.target;
  await q(
    `UPDATE quests_daily SET progress = $4, meta = $5, completed_at = CASE WHEN $6 THEN now() ELSE NULL END
      WHERE user_id = $1 AND day = $2 AND quest_key = $3`,
    [userId, day, key, progress, JSON.stringify(meta), done], c,
  );
  return done ? row.reward * (plus ? 2 : 1) : 0;
}

export async function grantEnergy(c: pg.PoolClient, userId: string, gain: number) {
  const comp = await one<{ level: number; energy: number }>('SELECT level, energy FROM companions WHERE user_id = $1 FOR UPDATE', [userId], c);
  const next = applyEnergy(comp!.level, comp!.energy, gain);
  await q('UPDATE companions SET level = $2, energy = $3, updated_at = now() WHERE user_id = $1', [userId, next.level, next.energy], c);
  return next;
}

/**
 * Progress a social quest outside any other transaction and tell the app. uniqueKey counts each friend once.
 * Best effort: a quest hiccup never fails the cheer / sticker / guestbook note that triggered it.
 */
export async function recordSocialQuest(userId: string, key: SocialQuestKey | 'sticker', uniqueKey?: string) {
  try {
    const plus = await isPlus(userId);
    const out = await tx(async (c) => {
      const gained = await progressQuest(c, userId, key, plus, uniqueKey);
      if (!gained) return null;
      const next = await grantEnergy(c, userId, gained);
      return { energy: next.energy, level: next.level, leveledUp: next.leveledUp, quests: await ensureQuests(userId, c) };
    });
    if (!out) return;
    toUser(userId, 'quest:update', { quests: out.quests, energy: out.energy, level: out.level });
    if (out.leveledUp) await enqueue.push(`level:${userId}:${out.level}`, { kind: 'level', userId, level: out.level });
  } catch (err) {
    log.warn({ err: (err as Error).message, userId, key }, 'social quest progress failed');
  }
}

/** Grant a streak milestone once per account. Items already owned turn into their price in coins. */
async function grantMilestone(c: pg.PoolClient, userId: string, m: StreakMilestoneReward): Promise<StreakMilestoneReward | null> {
  const fresh = await c.query('INSERT INTO streak_rewards (user_id, milestone) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, m.day]);
  if ((fresh.rowCount ?? 0) === 0) return null;
  let coins = m.coins;
  let itemId: string | undefined;
  if (m.itemId) {
    if (await grantInventoryItemTx(c, userId, m.itemId, 'streak')) itemId = m.itemId;
    else coins += getCatalogItem(m.itemId)?.priceCoins ?? 0;
  }
  if (coins > 0) await adjustCoinsTx(c, userId, coins, 'streak', `streak:${m.day}`);
  if (m.shields) await c.query(`UPDATE companions SET shields = LEAST(shields + $2, ${MAX_SHIELDS}) WHERE user_id = $1`, [userId, m.shields]);
  return { day: m.day, coins, ...(itemId ? { itemId } : {}), ...(m.shields ? { shields: m.shields } : {}) };
}

export async function companionAction(userId: string, action: CompanionAction): Promise<ActionResult> {
  const rule = ACTION_RULES[action];
  if (!rule) throw E.badRequest('Unknown action');
  const plus = await isPlus(userId);
  if (rule.plus && !plus) throw E.plusRequired(action);

  const result = await tx(async (c) => {
    const day = await userDay(userId, c);
    const comp = await one<{ level: number; streak: number; last_active_day: string | null; shield_used_at: string | null; shields: number; last_action_at: Date | null }>(
      'SELECT level, streak, last_active_day, shield_used_at, shields, last_action_at FROM companions WHERE user_id = $1 FOR UPDATE', [userId], c,
    );
    if (!comp) throw E.notFound('Companion not found');
    const now = new Date();
    const count = Number((await one<{ n: string }>('SELECT count(*) AS n FROM companion_actions WHERE user_id = $1 AND day = $2 AND action = $3', [userId, day, action], c))!.n);
    // Over the daily cap the action still plays but grants 0 energy.
    const gain = count < rule.dailyCap ? rule.gain * (plus ? 2 : 1) : 0;
    await q('INSERT INTO companion_actions (user_id, action, gain, day) VALUES ($1,$2,$3,$4)', [userId, action, gain, day], c);

    const s = streakAfterGap({
      streak: comp.streak, gap: comp.last_active_day ? dayDiff(comp.last_active_day, day) : null, plus,
      plusShieldReady: !comp.shield_used_at || dayDiff(comp.shield_used_at, day) >= 7, shields: comp.shields,
    });
    const shields = s.use === 'banked' ? comp.shields - 1 : comp.shields;
    await q(
      `UPDATE companions SET streak = $2, last_active_day = $3, shield_used_at = CASE WHEN $4 THEN $3::date ELSE shield_used_at END,
              shields = $5, last_action_at = $6 WHERE user_id = $1`,
      [userId, s.streak, day, s.use === 'plus', shields, now], c,
    );
    // A streak milestone counts the first time the streak reaches it (repeat actions on the same day don't re-check).
    const reached = s.streak !== comp.streak ? milestoneAt(s.streak) : null;
    const milestone = reached ? await grantMilestone(c, userId, reached) : null;

    // Welcome back after a long break: a little energy and coins (once, on the first action back).
    const comeback = isComeback(comp.last_action_at?.toISOString(), now.getTime()) ? { ...COMEBACK_BONUS } : null;
    if (comeback) await adjustCoinsTx(c, userId, comeback.coins, 'comeback', `comeback:${day}`);
    const egg: Egg | null = await warmEgg(c, userId, day);

    let questGain = 0;
    if (action === 'pet') questGain += await progressQuest(c, userId, 'pet', plus);
    if (action === 'feed') questGain += await progressQuest(c, userId, 'feed', plus);
    const next = await grantEnergy(c, userId, gain + questGain + (comeback?.energy ?? 0));
    const quests = await ensureQuests(userId, c);
    const after = (await one<{ shields: number; coins: number }>('SELECT shields, coins FROM companions WHERE user_id = $1', [userId], c))!;
    return {
      mood: rule.mood, line: rule.line, gain: gain + questGain + (comeback?.energy ?? 0), energy: next.energy, level: next.level,
      leveledUp: next.level > comp.level, streak: s.streak, quests,
      comeback, milestone, shields: after.shields, shieldUsed: s.use !== 'none', egg, coins: after.coins,
      lastActionAt: now.toISOString(), lastActiveDay: day,
    };
  });
  if (result.leveledUp) await enqueue.push(`level:${userId}:${result.level}`, { kind: 'level', userId, level: result.level });
  if (result.milestone || result.comeback) toUser(userId, 'wallet:update', { coins: result.coins! });
  if (result.milestone) await notifyFriends(userId, 'streak_milestone', { day: result.milestone.day }, `milestone:${userId}:${result.milestone.day}`);
  return result;
}

/** "Say hi to 3 friends": unique DM/group recipients of messages sent today (from the message.sent event). */
export async function recordMessageSent(senderId: string, recipientIds: string[]) {
  const plus = await isPlus(senderId);
  const out = await tx(async (c) => {
    let gained = 0;
    for (const r of recipientIds) gained += await progressQuest(c, senderId, 'hi3', plus, r);
    const next = gained ? await grantEnergy(c, senderId, gained) : await one<{ level: number; energy: number }>('SELECT level, energy FROM companions WHERE user_id = $1', [senderId], c);
    return { gained, energy: next!.energy, level: next!.level, quests: await ensureQuests(senderId, c) };
  });
  if (out.gained) toUser(senderId, 'quest:update', { quests: out.quests, energy: out.energy, level: out.level });
}

export async function patchCompanion(userId: string, p: { name?: string; palette?: PaletteId; equippedOutfit?: Outfit; equippedSlots?: Partial<EquippedSlots>; signatureMove?: Mood }): Promise<Companion> {
  if (p.palette && isPlusPalette(p.palette)) await requirePlus(userId, 'palette');
  // Anything that changes what Mo wears goes through equipSlots, which enforces Plus / level / ownership.
  // (Writing these columns directly here let the legacy endpoint equip items the user doesn't have.)
  if (p.equippedSlots !== undefined || p.equippedOutfit !== undefined) {
    const slots: Record<string, string | null | undefined> = { ...(p.equippedSlots ?? {}) };
    if (p.equippedOutfit !== undefined) {
      if (p.equippedOutfit === 'none') {
        const current = await getCompanion(userId);
        if (current.equippedOutfit !== 'none') slots[slotOfOutfit(current.equippedOutfit)] = null;
      } else {
        slots[slotOfOutfit(p.equippedOutfit)] = p.equippedOutfit;
      }
    }
    await equipSlots(userId, { slots: slots as Partial<EquippedSlots> });
    p = { ...p, equippedSlots: undefined, equippedOutfit: undefined };
  }
  if (p.signatureMove && isPlusMove(p.signatureMove)) await requirePlus(userId, 'move');
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  if (p.name !== undefined) { vals.push(p.name.trim().slice(0, 24) || 'Mo'); sets.push(`name = $${vals.length}`); }
  if (p.palette !== undefined) { vals.push(p.palette); sets.push(`palette = $${vals.length}`); }
  if (p.signatureMove !== undefined) { vals.push(p.signatureMove); sets.push(`signature_move = $${vals.length}`); }
  if (sets.length) {
    const r = await one<Parameters<typeof companionFromRow>[0]>(`UPDATE companions SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1 RETURNING *`, vals);
    // Outfit / palette show in other people's chats and rooms.
    if (p.palette !== undefined || p.equippedOutfit !== undefined || p.equippedSlots !== undefined || p.signatureMove !== undefined) {
      const style = await userStyleOf(userId);
      if (style) toUsers([...(await peersOf(userId)), userId], 'style:update', style);
    }
    return companionFromRow(r!);
  }
  return getCompanion(userId);
}
