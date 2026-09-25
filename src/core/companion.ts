import type pg from 'pg';
import { one, q, tx } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { dayDiff, localDay } from '../lib/time.js';
import { applyEnergy, isPlusMove, isPlusOutfit, isPlusPalette, outfitLevel, outfitName } from '../shared/rules.js';
import { ACTION_RULES, type ActionResult, type Companion, type CompanionAction, type Mood, type Outfit, type PaletteId, type Quest } from '../shared/types.js';
import { isPlus, requirePlus } from './entitlements.js';
import { companionFromRow, getCompanion, peersOf, userStyleOf } from './users.js';
import { toUsers } from '../lib/emitter.js';

/** Daily quests (doc section 7). Rewards are doubled for Plus when granted. */
const QUEST_DEFS = (name: string) => [
  { key: 'pet', title: `Pet ${name}`, target: 1, reward: 5 },
  { key: 'feed', title: `Feed ${name} a snack`, target: 1, reward: 10 },
  { key: 'hi3', title: 'Say hi to 3 friends', target: 3, reward: 30 },
];

interface QuestRow { quest_key: string; title: string; target: number; progress: number; reward: number; completed_at: Date | null }
const questFromRow = (r: QuestRow): Quest => ({ key: r.quest_key, title: r.title, reward: r.reward, target: r.target, progress: Math.min(r.progress, r.target), done: !!r.completed_at });

async function userDay(userId: string, db?: pg.PoolClient) {
  const u = await one<{ timezone: string }>('SELECT timezone FROM users WHERE id = $1', [userId], db);
  return localDay(u?.timezone ?? 'UTC');
}

/** Today's quests in the user's timezone; created lazily at their first request after local midnight. */
export async function ensureQuests(userId: string, db?: pg.PoolClient): Promise<Quest[]> {
  const day = await userDay(userId, db);
  let rows = await q<QuestRow>('SELECT * FROM quests_daily WHERE user_id = $1 AND day = $2 ORDER BY reward', [userId, day], db);
  if (rows.length === 0) {
    const name = (await one<{ name: string }>('SELECT name FROM companions WHERE user_id = $1', [userId], db))?.name ?? 'Mo';
    for (const d of QUEST_DEFS(name)) {
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

/** Streak: at least one action per local day. Missing a day resets to 1; Plus shield forgives exactly one missed day per 7 days. */
function nextStreak(prev: { streak: number; last: string | null; shield: string | null }, today: string, plus: boolean): { streak: number; shieldUsed: boolean } {
  if (!prev.last) return { streak: 1, shieldUsed: false };
  const gap = dayDiff(prev.last, today);
  if (gap <= 0) return { streak: Math.max(prev.streak, 1), shieldUsed: false };
  if (gap === 1) return { streak: prev.streak + 1, shieldUsed: false };
  const shieldReady = !prev.shield || dayDiff(prev.shield, today) >= 7;
  if (gap === 2 && plus && shieldReady) return { streak: prev.streak + 1, shieldUsed: true };
  return { streak: 1, shieldUsed: false };
}

export async function companionAction(userId: string, action: CompanionAction): Promise<ActionResult> {
  const rule = ACTION_RULES[action];
  if (!rule) throw E.badRequest('Unknown action');
  const plus = await isPlus(userId);
  if (rule.plus && !plus) throw E.plusRequired(action);

  const result = await tx(async (c) => {
    const day = await userDay(userId, c);
    const comp = await one<{ level: number; streak: number; last_active_day: string | null; shield_used_at: string | null }>(
      'SELECT level, streak, last_active_day, shield_used_at FROM companions WHERE user_id = $1 FOR UPDATE', [userId], c,
    );
    if (!comp) throw E.notFound('Companion not found');
    const count = Number((await one<{ n: string }>('SELECT count(*) AS n FROM companion_actions WHERE user_id = $1 AND day = $2 AND action = $3', [userId, day, action], c))!.n);
    // Over the daily cap the action still plays but grants 0 energy.
    const gain = count < rule.dailyCap ? rule.gain * (plus ? 2 : 1) : 0;
    await q('INSERT INTO companion_actions (user_id, action, gain, day) VALUES ($1,$2,$3,$4)', [userId, action, gain, day], c);

    const s = nextStreak({ streak: comp.streak, last: comp.last_active_day, shield: comp.shield_used_at }, day, plus);
    await q(
      `UPDATE companions SET streak = $2, last_active_day = $3, shield_used_at = CASE WHEN $4 THEN $3::date ELSE shield_used_at END WHERE user_id = $1`,
      [userId, s.streak, day, s.shieldUsed], c,
    );

    let questGain = 0;
    if (action === 'pet') questGain += await progressQuest(c, userId, 'pet', plus);
    if (action === 'feed') questGain += await progressQuest(c, userId, 'feed', plus);
    const next = await grantEnergy(c, userId, gain + questGain);
    const quests = await ensureQuests(userId, c);
    return {
      mood: rule.mood, line: rule.line, gain: gain + questGain, energy: next.energy, level: next.level,
      leveledUp: next.level > comp.level, streak: s.streak, quests,
    };
  });
  if (result.leveledUp) await enqueue.push(`level:${userId}:${result.level}`, { kind: 'level', userId, level: result.level });
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

export async function patchCompanion(userId: string, p: { name?: string; palette?: PaletteId; equippedOutfit?: Outfit; signatureMove?: Mood }): Promise<Companion> {
  if (p.palette && isPlusPalette(p.palette)) await requirePlus(userId, 'palette');
  if (p.equippedOutfit && isPlusOutfit(p.equippedOutfit)) await requirePlus(userId, 'outfit');
  const needLevel = p.equippedOutfit ? outfitLevel(p.equippedOutfit) : 0;
  if (needLevel) {
    const lvl = (await one<{ level: number }>('SELECT level FROM companions WHERE user_id = $1', [userId]))?.level ?? 1;
    if (lvl < needLevel) throw new AppError(403, 'LEVEL_REQUIRED', `${outfitName(p.equippedOutfit!)} unlocks at level ${needLevel}`, { level: needLevel });
  }
  if (p.signatureMove && isPlusMove(p.signatureMove)) await requirePlus(userId, 'move');
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  if (p.name !== undefined) { vals.push(p.name.trim().slice(0, 24) || 'Mo'); sets.push(`name = $${vals.length}`); }
  if (p.palette !== undefined) { vals.push(p.palette); sets.push(`palette = $${vals.length}`); }
  if (p.equippedOutfit !== undefined) { vals.push(p.equippedOutfit); sets.push(`equipped_outfit = $${vals.length}`); }
  if (p.signatureMove !== undefined) { vals.push(p.signatureMove); sets.push(`signature_move = $${vals.length}`); }
  if (sets.length) {
    const r = await one<Parameters<typeof companionFromRow>[0]>(`UPDATE companions SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1 RETURNING *`, vals);
    // Outfit / palette show in other people's chats and rooms.
    if (p.palette !== undefined || p.equippedOutfit !== undefined || p.signatureMove !== undefined) {
      const style = await userStyleOf(userId);
      if (style) toUsers([...(await peersOf(userId)), userId], 'style:update', style);
    }
    return companionFromRow(r!);
  }
  return getCompanion(userId);
}
