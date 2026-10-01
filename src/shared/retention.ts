// Mirror of sproutly/src/data/retention.ts — the app/server contract for streaks, eggs, shop, friend streaks and
// activity. Pure functions only (no I/O) so both sides compute exactly the same thing. Keep in sync.
import type { ActivityKind, CompanionNeed, FriendStreak, ShopOfferId, StreakMilestoneReward } from './types.js';

// ---------- dates ----------
/** Whole days between two YYYY-MM-DD strings (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}
/** YYYY-MM-DD shifted by n days. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
export const utcDay = (at: Date = new Date()) => at.toISOString().slice(0, 10);

// ---------- streak shields ----------
/** Banked shields (earned from the 7-day drop track, streak milestones or the shop) cap here. */
export const MAX_SHIELDS = 3;
/** Every new companion starts with one shield, so the first missed day is never a disaster. */
export const STARTER_SHIELDS = 1;

/**
 * Streak after an action `gap` days after the last active day. A single missed day (gap 2) is forgiven by Plus's
 * weekly shield first, then by a banked shield. Two or more missed days always restart.
 */
export function streakAfterGap(p: { streak: number; gap: number | null; plus: boolean; plusShieldReady: boolean; shields: number }): { streak: number; use: 'none' | 'plus' | 'banked' } {
  if (p.gap === null) return { streak: 1, use: 'none' };
  if (p.gap <= 0) return { streak: Math.max(p.streak, 1), use: 'none' };
  if (p.gap === 1) return { streak: p.streak + 1, use: 'none' };
  if (p.gap === 2 && p.streak > 0) {
    if (p.plus && p.plusShieldReady) return { streak: p.streak + 1, use: 'plus' };
    if (p.shields > 0) return { streak: p.streak + 1, use: 'banked' };
  }
  return { streak: 1, use: 'none' };
}

/** Whether the nightly reset should keep a streak (it can still be saved by the next action). */
export function streakStillAlive(p: { gap: number; plus: boolean; plusShieldReady: boolean; shields: number }): boolean {
  return p.gap <= 1 || (p.gap === 2 && ((p.plus && p.plusShieldReady) || p.shields > 0));
}

// ---------- streak milestones ----------
/** Granted once per account the first time the streak reaches the day. An item already owned becomes its price in coins. */
export const STREAK_MILESTONES: StreakMilestoneReward[] = [
  { day: 3, coins: 30 },
  { day: 7, coins: 50, itemId: 'scarf' },
  { day: 14, coins: 100, itemId: 'flower' },
  { day: 30, coins: 200, shields: 1 },
  { day: 50, coins: 300 },
  { day: 100, coins: 1000, shields: 1 },
  { day: 365, coins: 3650, shields: 1 },
];
export const milestoneAt = (day: number) => STREAK_MILESTONES.find((m) => m.day === day) ?? null;
export const nextMilestone = (streak: number) => STREAK_MILESTONES.find((m) => m.day > streak) ?? null;

// ---------- comeback ----------
/** The first action after this long away earns a welcome-back gift. */
export const COMEBACK_AFTER_H = 72;
export const COMEBACK_BONUS = { energy: 50, coins: 25 } as const;
export const isComeback = (lastActionAt: string | null | undefined, now = Date.now()) =>
  !!lastActionAt && now - Date.parse(lastActionAt) >= COMEBACK_AFTER_H * 3600_000;

// ---------- companion needs (no penalties: only how Mo looks and talks) ----------
export function companionNeed(lastActionAt: string | null | undefined, now = Date.now()): CompanionNeed {
  if (!lastActionAt) return 'content';
  const h = (now - Date.parse(lastActionAt)) / 3600_000;
  if (!Number.isFinite(h) || h < 12) return 'content';
  if (h < 30) return 'peckish';
  if (h < COMEBACK_AFTER_H) return 'lonely';
  return 'missing';
}
export function needLine(need: CompanionNeed, name: string): string | null {
  switch (need) {
    case 'peckish': return `My tummy's rumbling… snack?`;
    case 'lonely': return `There you are! ${name} missed you 🥺`;
    case 'missing': return `You're back!! I saved you a welcome gift 🎁`;
    default: return null;
  }
}

// ---------- eggs ----------
/** Days (distinct local days with at least one companion action) an egg needs to hatch. */
export const EGG_DAYS = 3;
/** Earnable items the companion can actually wear; the rest of an egg's value is coins. */
export const EGG_ITEMS = ['scarf', 'flower'] as const;

/** 35% an unowned egg item, otherwise 40-150 coins. Always some energy. `rand` returns [0, 1). */
export function rollEggReward(rand: () => number, owned: ReadonlySet<string>): { coins: number; energy: number; itemId: string | null } {
  const unowned = EGG_ITEMS.filter((i) => !owned.has(i));
  if (unowned.length && rand() < 0.35) {
    return { coins: 0, energy: 50, itemId: unowned[Math.floor(rand() * unowned.length)] ?? unowned[0]! };
  }
  const r = rand();
  const coins = r < 0.6 ? 40 : r < 0.9 ? 80 : 150;
  return { coins, energy: 50, itemId: null };
}

// ---------- social quests (one rotates in each day next to pet / feed / say hi) ----------
export const SOCIAL_QUESTS = [
  { key: 'visit2', title: "Cheer 2 friends' rooms", target: 2, reward: 20 },
  { key: 'sticker', title: 'Send a friend a sticker', target: 1, reward: 10 },
  { key: 'guestbook', title: "Sign a friend's guestbook", target: 1, reward: 15 },
] as const;
export type SocialQuestKey = (typeof SOCIAL_QUESTS)[number]['key'];
export function socialQuestFor(day: string) {
  const n = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
  return SOCIAL_QUESTS[((n % SOCIAL_QUESTS.length) + SOCIAL_QUESTS.length) % SOCIAL_QUESTS.length]!;
}

// ---------- friend streaks (DMs, both people message on the same UTC day) ----------
export const FRIEND_STREAK_MILESTONES = [3, 7, 30, 100];
export interface FriendStreakRow { count: number; lastDay: string | null; aDay: string | null; bDay: string | null }

/** Record that `side` messaged on `today`. The streak grows once per day, when the second person messages. */
export function friendStreakStep(row: FriendStreakRow, side: 'a' | 'b', today: string): FriendStreakRow & { extended: boolean } {
  const next = { ...row, [side === 'a' ? 'aDay' : 'bDay']: today } as FriendStreakRow;
  if (next.aDay === today && next.bDay === today && next.lastDay !== today) {
    const continues = next.lastDay !== null && daysBetween(next.lastDay, today) === 1;
    return { ...next, count: continues ? next.count + 1 : 1, lastDay: today, extended: true };
  }
  return { ...next, extended: false };
}

/** What a DM row shows. null once the streak has lapsed (or never started). */
export function friendStreakView(row: FriendStreakRow | null, side: 'a' | 'b', today: string): FriendStreak | null {
  if (!row || !row.lastDay || row.count <= 0) return null;
  const gap = daysBetween(row.lastDay, today);
  if (gap > 1) return null;
  const mine = side === 'a' ? row.aDay : row.bDay;
  const theirs = side === 'a' ? row.bDay : row.aDay;
  return { count: row.count, atRisk: gap === 1, sentToday: mine === today, theyToday: theirs === today };
}

// ---------- room visits ----------
/** Coins the owner gets for each friend's daily room cheer, up to ROOM_GIFTS_PER_DAY cheers a day. */
export const ROOM_GIFT_COINS = 5;
export const ROOM_GIFTS_PER_DAY = 10;

// ---------- shop (coins only; rotates weekly, Monday 00:00 UTC) ----------
export const SHOP_OFFERS: { id: ShopOfferId; kind: 'item' | 'shield' | 'egg'; name: string; description: string; price: number }[] = [
  { id: 'scarf', kind: 'item', name: 'Cozy Scarf', description: 'Warm knitted winter scarf.', price: 100 },
  { id: 'flower', kind: 'item', name: 'Flower Crown', description: 'Freshly picked blooming blossoms.', price: 150 },
  { id: 'shield', kind: 'shield', name: 'Streak Shield', description: 'Saves your streak if you miss a day.', price: 150 },
  { id: 'egg', kind: 'egg', name: 'Mystery Egg', description: 'Hatches in 3 days. Coins or something to wear!', price: 200 },
];
export const FEATURED_DISCOUNT = 0.3;
/** Weeks since 1970-01-05 (a Monday), UTC. */
export const shopWeek = (at: Date = new Date()) => Math.floor((at.getTime() - Date.UTC(1970, 0, 5)) / (7 * 86400000));
export const shopWeekEnds = (at: Date = new Date()) => new Date(Date.UTC(1970, 0, 5) + (shopWeek(at) + 1) * 7 * 86400000).toISOString();
export const featuredOffer = (at: Date = new Date()): ShopOfferId => SHOP_OFFERS[shopWeek(at) % SHOP_OFFERS.length]!.id;
export function offerPrice(id: ShopOfferId, at: Date = new Date()): number {
  const o = SHOP_OFFERS.find((x) => x.id === id);
  if (!o) return 0;
  return featuredOffer(at) === id ? Math.round(o.price * (1 - FEATURED_DISCOUNT)) : o.price;
}

// ---------- activity ----------
export function activityText(kind: ActivityKind, actorName: string, data: Record<string, unknown>): string {
  const n = (k: string) => (typeof data[k] === 'number' ? (data[k] as number) : 0);
  switch (kind) {
    case 'guestbook': return `${actorName} signed your guestbook`;
    case 'room_visit': return n('coins') > 0 ? `${actorName} cheered your room and left ${n('coins')} coins` : `${actorName} cheered your room`;
    case 'level_up': return `${actorName}'s companion reached level ${n('level')}`;
    case 'streak_milestone': return `${actorName} hit a ${n('day')}-day streak 🔥`;
    case 'friend_streak': return `You and ${actorName} are on a ${n('count')}-day chat streak 🔥`;
    case 'egg_hatched': return `${actorName}'s egg hatched 🐣`;
  }
}

// ---------- level-ups pay coins (so levelling feeds the shop) ----------
export const levelCoins = (level: number) => Math.min(200, 20 + Math.max(0, level) * 5);

// ---------- daily quest chest: finish every quest today, open it once ----------
export const QUEST_CHEST = { coins: 30, energy: 25 } as const;
export const chestReady = (quests: { done: boolean }[]) => quests.length > 0 && quests.every((q) => q.done);
