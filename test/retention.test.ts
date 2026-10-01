import { describe, expect, it } from 'vitest';
import {
  COMEBACK_AFTER_H, EGG_ITEMS, FEATURED_DISCOUNT, SHOP_OFFERS, SOCIAL_QUESTS, STREAK_MILESTONES,
  activityText, addDays, companionNeed, daysBetween, featuredOffer, friendStreakStep, friendStreakView, isComeback,
  milestoneAt, nextMilestone, offerPrice, rollEggReward, shopWeek, shopWeekEnds, socialQuestFor, streakAfterGap, streakStillAlive,
  type FriendStreakRow,
} from '../src/shared/retention.js';

const base = { streak: 10, plus: false, plusShieldReady: false, shields: 0 };

describe('streakAfterGap', () => {
  it('starts at 1 with no history', () => expect(streakAfterGap({ ...base, gap: null })).toEqual({ streak: 1, use: 'none' }));
  it('keeps the streak on the same day (never below 1)', () => {
    expect(streakAfterGap({ ...base, gap: 0 })).toEqual({ streak: 10, use: 'none' });
    expect(streakAfterGap({ ...base, streak: 0, gap: 0 })).toEqual({ streak: 1, use: 'none' });
  });
  it('a clock going backwards never resets', () => expect(streakAfterGap({ ...base, gap: -1 }).streak).toBe(10));
  it('grows on the next day', () => expect(streakAfterGap({ ...base, gap: 1 })).toEqual({ streak: 11, use: 'none' }));
  it('one missed day without shields restarts', () => expect(streakAfterGap({ ...base, gap: 2 })).toEqual({ streak: 1, use: 'none' }));
  it('one missed day uses a banked shield', () => expect(streakAfterGap({ ...base, gap: 2, shields: 1 })).toEqual({ streak: 11, use: 'banked' }));
  it('Plus weekly shield is used before a banked one', () =>
    expect(streakAfterGap({ ...base, gap: 2, plus: true, plusShieldReady: true, shields: 2 })).toEqual({ streak: 11, use: 'plus' }));
  it('Plus with its weekly shield spent falls back to a banked one', () =>
    expect(streakAfterGap({ ...base, gap: 2, plus: true, plusShieldReady: false, shields: 1 })).toEqual({ streak: 11, use: 'banked' }));
  it('two missed days always restart, shields or not', () =>
    expect(streakAfterGap({ ...base, gap: 3, plus: true, plusShieldReady: true, shields: 3 })).toEqual({ streak: 1, use: 'none' }));
  it('a shield is never spent on a streak that is already 0', () =>
    expect(streakAfterGap({ ...base, streak: 0, gap: 2, shields: 1 })).toEqual({ streak: 1, use: 'none' }));
});

describe('streakStillAlive (nightly reset agrees with the next action)', () => {
  for (const gap of [0, 1, 2, 3, 10]) {
    for (const shields of [0, 1]) {
      for (const [plus, ready] of [[false, false], [true, true], [true, false]] as const) {
        it(`gap ${gap}, shields ${shields}, plus ${plus}/${ready}`, () => {
          const alive = streakStillAlive({ gap, plus, plusShieldReady: ready, shields });
          const next = streakAfterGap({ streak: 5, gap, plus, plusShieldReady: ready, shields });
          expect(alive).toBe(next.streak > 1 || gap <= 1);
        });
      }
    }
  }
});

describe('milestones', () => {
  it('are strictly increasing and positive', () => {
    for (let i = 1; i < STREAK_MILESTONES.length; i++) expect(STREAK_MILESTONES[i]!.day).toBeGreaterThan(STREAK_MILESTONES[i - 1]!.day);
    for (const m of STREAK_MILESTONES) expect(m.coins).toBeGreaterThan(0);
  });
  it('only reward items that exist and can be earned', () => {
    for (const m of STREAK_MILESTONES) if (m.itemId) expect(EGG_ITEMS as readonly string[]).toContain(m.itemId);
  });
  it('look up exact days only', () => {
    expect(milestoneAt(7)?.itemId).toBe('scarf');
    expect(milestoneAt(8)).toBeNull();
  });
  it('next milestone is the first one after the streak', () => {
    expect(nextMilestone(0)?.day).toBe(3);
    expect(nextMilestone(3)?.day).toBe(7);
    expect(nextMilestone(365)).toBeNull();
  });
});

describe('companion needs and comeback', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now - h * 3600_000).toISOString();
  it('maps time away to a need', () => {
    expect(companionNeed(null, now)).toBe('content');
    expect(companionNeed(hoursAgo(2), now)).toBe('content');
    expect(companionNeed(hoursAgo(20), now)).toBe('peckish');
    expect(companionNeed(hoursAgo(40), now)).toBe('lonely');
    expect(companionNeed(hoursAgo(COMEBACK_AFTER_H), now)).toBe('missing');
  });
  it('treats garbage and future dates as content', () => {
    expect(companionNeed('not a date', now)).toBe('content');
    expect(companionNeed(hoursAgo(-5), now)).toBe('content');
  });
  it('comeback only after the threshold and only with history', () => {
    expect(isComeback(null, now)).toBe(false);
    expect(isComeback(hoursAgo(COMEBACK_AFTER_H - 1), now)).toBe(false);
    expect(isComeback(hoursAgo(COMEBACK_AFTER_H), now)).toBe(true);
  });
  it('"missing" lines up with the comeback gift', () => {
    expect(companionNeed(hoursAgo(COMEBACK_AFTER_H), now) === 'missing').toBe(isComeback(hoursAgo(COMEBACK_AFTER_H), now));
  });
});

describe('eggs', () => {
  const seq = (...xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]!; };
  it('can give an unowned item', () => {
    const r = rollEggReward(seq(0.1, 0.99), new Set());
    expect(r.itemId).toBe('flower');
    expect(r.coins).toBe(0);
    expect(r.energy).toBeGreaterThan(0);
  });
  it('never gives an item you already own', () => {
    for (let i = 0; i < 200; i++) {
      const r = rollEggReward(Math.random, new Set(EGG_ITEMS));
      expect(r.itemId).toBeNull();
      expect([40, 80, 150]).toContain(r.coins);
    }
  });
  it('always gives something', () => {
    for (let i = 0; i < 200; i++) {
      const r = rollEggReward(Math.random, new Set(['scarf']));
      expect(r.coins > 0 || r.itemId !== null).toBe(true);
      if (r.itemId) expect(r.itemId).toBe('flower');
    }
  });
});

describe('social quest rotation', () => {
  it('cycles through every social quest on consecutive days', () => {
    const keys = new Set([0, 1, 2].map((n) => socialQuestFor(addDays('2026-10-01', n)).key));
    expect(keys.size).toBe(SOCIAL_QUESTS.length);
  });
  it('is stable for a given day', () => expect(socialQuestFor('2026-10-01')).toBe(socialQuestFor('2026-10-01')));
  it('works before 1970 and for odd input', () => expect(socialQuestFor('1969-12-25').key).toBeTruthy());
});

describe('friend streaks', () => {
  const empty: FriendStreakRow = { count: 0, lastDay: null, aDay: null, bDay: null };
  it('needs both people on the same day', () => {
    const one = friendStreakStep(empty, 'a', '2026-10-01');
    expect(one.extended).toBe(false);
    expect(one.count).toBe(0);
    const both = friendStreakStep(one, 'b', '2026-10-01');
    expect(both).toMatchObject({ count: 1, lastDay: '2026-10-01', extended: true });
  });
  it('a second message the same day changes nothing', () => {
    const r = friendStreakStep(friendStreakStep(empty, 'a', '2026-10-01'), 'b', '2026-10-01');
    expect(friendStreakStep(r, 'a', '2026-10-01')).toMatchObject({ count: 1, extended: false });
  });
  it('grows on consecutive days, restarts after a gap', () => {
    let r: FriendStreakRow = empty;
    for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) { r = friendStreakStep(r, 'a', d); r = friendStreakStep(r, 'b', d); }
    expect(r.count).toBe(3);
    r = friendStreakStep(r, 'b', '2026-10-05');
    r = friendStreakStep(r, 'a', '2026-10-05');
    expect(r.count).toBe(1);
  });
  it('messages on different days never count', () => {
    let r = friendStreakStep(empty, 'a', '2026-10-01');
    r = friendStreakStep(r, 'b', '2026-10-02');
    expect(r.count).toBe(0);
  });
  it('view: alive today, at risk tomorrow, gone after', () => {
    const r = { count: 4, lastDay: '2026-10-01', aDay: '2026-10-01', bDay: '2026-10-01' };
    expect(friendStreakView(r, 'a', '2026-10-01')).toEqual({ count: 4, atRisk: false, sentToday: true, theyToday: true });
    expect(friendStreakView(r, 'b', '2026-10-02')).toEqual({ count: 4, atRisk: true, sentToday: false, theyToday: false });
    expect(friendStreakView(r, 'a', '2026-10-03')).toBeNull();
    expect(friendStreakView(null, 'a', '2026-10-01')).toBeNull();
    expect(friendStreakView({ ...r, count: 0 }, 'a', '2026-10-01')).toBeNull();
  });
  it('view tells each side who has already sent today', () => {
    const r = { count: 4, lastDay: '2026-10-01', aDay: '2026-10-02', bDay: '2026-10-01' };
    expect(friendStreakView(r, 'a', '2026-10-02')).toMatchObject({ atRisk: true, sentToday: true, theyToday: false });
    expect(friendStreakView(r, 'b', '2026-10-02')).toMatchObject({ atRisk: true, sentToday: false, theyToday: true });
  });
});

describe('shop', () => {
  it('weeks start on Monday 00:00 UTC', () => {
    const sun = new Date('2026-10-04T23:59:59Z');
    const mon = new Date('2026-10-05T00:00:00Z');
    expect(shopWeek(mon)).toBe(shopWeek(sun) + 1);
    expect(shopWeekEnds(sun)).toBe('2026-10-05T00:00:00.000Z');
    expect(new Date(shopWeekEnds(mon)).getUTCDay()).toBe(1);
  });
  it('features every offer over a cycle and discounts only the featured one', () => {
    const seen = new Set<string>();
    for (let w = 0; w < SHOP_OFFERS.length; w++) {
      const at = new Date(Date.UTC(2026, 9, 5) + w * 7 * 86400000);
      const f = featuredOffer(at);
      seen.add(f);
      for (const o of SHOP_OFFERS) {
        expect(offerPrice(o.id, at)).toBe(o.id === f ? Math.round(o.price * (1 - FEATURED_DISCOUNT)) : o.price);
      }
    }
    expect(seen.size).toBe(SHOP_OFFERS.length);
  });
});

describe('dates and text', () => {
  it('day math', () => {
    expect(daysBetween('2026-10-01', '2026-10-02')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2); // across a DST change somewhere
  });
  it('activity text for every kind', () => {
    expect(activityText('room_visit', 'Ana', { coins: 5 })).toContain('5 coins');
    expect(activityText('room_visit', 'Ana', { coins: 0 })).toBe('Ana cheered your room');
    expect(activityText('level_up', 'Ana', { level: 9 })).toContain('level 9');
    expect(activityText('friend_streak', 'Ana', { count: 7 })).toContain('7-day');
    expect(activityText('streak_milestone', 'Ana', { day: 30 })).toContain('30-day');
    expect(activityText('guestbook', 'Ana', {})).toContain('guestbook');
    expect(activityText('egg_hatched', 'Ana', {})).toContain('egg');
  });
});
