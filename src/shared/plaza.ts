// Mirror of sproutly/src/data/plaza.ts — the Plaza contract (public hangout spots). Keep in sync.
import type { PlazaEmote, PlazaSpotId } from './types.js';

export const PLAZA_SPOTS: { id: PlazaSpotId; name: string; blurb: string; emoji: string }[] = [
  { id: 'cafe', name: 'Café', blurb: 'Warm drinks and easy chats', emoji: '☕' },
  { id: 'park', name: 'Park', blurb: 'Fountain, trees and wanderers', emoji: '🌳' },
  { id: 'beach', name: 'Beach', blurb: 'Waves and sunsets', emoji: '🏖️' },
  { id: 'rooftop', name: 'Rooftop', blurb: 'City lights up high', emoji: '🌆' },
  { id: 'library', name: 'Library', blurb: 'Quiet corner, study buddies', emoji: '📚' },
  { id: 'garden', name: 'Garden', blurb: 'Cherry blossoms all year', emoji: '🌸' },
];
export const PLAZA_SPOT_IDS = PLAZA_SPOTS.map((s) => s.id) as [PlazaSpotId, ...PlazaSpotId[]];
export const PLAZA_EMOTES: PlazaEmote[] = ['wave', 'heart', 'laugh', 'dance', 'cheer'];
export const PLAZA_EMOJI: Record<PlazaEmote, string> = { wave: '👋', heart: '💖', laugh: '😂', dance: '💃', cheer: '🎉' };

/** Companions per spot; past that the spot shows "Full" and you pick another. */
export const PLAZA_CAPACITY = 30;
/** Local chat: short lines, a few at a time, kept briefly so people arriving see the last few. */
export const PLAZA_SAY_MAX = 80;
export const PLAZA_HISTORY = 20;
export const PLAZA_HISTORY_TTL_S = 10 * 60;
export const PLAZA_LIMITS = { moveMs: 150, emoteMs: 800, say: { points: 5, windowS: 10 } } as const;

/** Where you can stand: the floor band of every scene (x, y are 0..1 of the stage). */
export const PLAZA_FLOOR = { minX: 0.06, maxX: 0.94, minY: 0.42, maxY: 0.92 } as const;
export function clampToFloor(x: number, y: number) {
  const c = (v: number, a: number, b: number) => Math.min(b, Math.max(a, Number.isFinite(v) ? v : (a + b) / 2));
  return { x: c(x, PLAZA_FLOOR.minX, PLAZA_FLOOR.maxX), y: c(y, PLAZA_FLOOR.minY, PLAZA_FLOOR.maxY) };
}
/** A fresh arrival's spot: somewhere near the front middle, nudged so arrivals don't stack. */
export function arrivalPoint(rand: () => number) {
  return clampToFloor(0.3 + rand() * 0.4, 0.7 + rand() * 0.15);
}
/** Depth: companions further back (smaller y) are drawn smaller and behind. */
export const depthScale = (y: number) => 0.62 + 0.38 * ((y - PLAZA_FLOOR.minY) / (PLAZA_FLOOR.maxY - PLAZA_FLOOR.minY));
