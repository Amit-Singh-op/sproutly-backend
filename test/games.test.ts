import { describe, expect, it } from 'vitest';
import { GAME_IDS, GAMES, coinsFor, plausible, weekEndsAt, weekKey } from '../src/shared/games.js';

describe('minigame rules', () => {
  it('pays coins per run, capped', () => {
    expect(coinsFor('hop', 7)).toBe(7);
    expect(coinsFor('hop', 500)).toBe(GAMES.hop.maxCoinsPerRun);
    expect(coinsFor('memory', 1000)).toBe(25);
    expect(coinsFor('catch', 2)).toBe(0);
  });

  it('rejects scores nobody could reach in the time played', () => {
    expect(plausible('hop', 10, 15)).toBe(true);
    expect(plausible('hop', 100, 15)).toBe(false);
    expect(plausible('whack', 60, 30)).toBe(true);
    expect(plausible('whack', 60, 5)).toBe(false); // ended far too early
    expect(plausible('memory', 900, 3)).toBe(false);
    expect(plausible('memory', 1001, 60)).toBe(false);
    expect(plausible('simon', 8, 40)).toBe(true);
    expect(plausible('simon', 30, 40)).toBe(false);
    expect(plausible('catch', -1, 10)).toBe(false);
    expect(plausible('stack', 1.5, 10)).toBe(false);
  });

  it('always accepts a zero score', () => {
    for (const g of GAME_IDS) expect(plausible(g, 0, 0.1)).toBe(true);
  });

  it('weeks are ISO weeks in UTC and end on Monday', () => {
    expect(weekKey(new Date('2026-10-09T12:00:00Z'))).toBe('2026-W41');
    expect(weekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(weekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(weekEndsAt(new Date('2026-10-09T12:00:00Z'))).toBe('2026-10-12T00:00:00.000Z');
    expect(weekEndsAt(new Date('2026-10-12T00:00:00Z'))).toBe('2026-10-19T00:00:00.000Z');
  });
});
