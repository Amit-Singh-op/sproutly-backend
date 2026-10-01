// Mirror of sproutly/src/data/plaza.ts — the Plaza contract (public hangout spots). Keep in sync.
import type { PlazaBall, PlazaEmote, PlazaSpotId } from './types.js';

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

// ---------- shared ball (physics) ----------
// Every phone runs the same simulation from the same kick, so all see the ball in the same place. Units: x and y
// are fractions of the world floor (like positions), z is height above the ground as a fraction of stage height.
export type BallKind = 'soccer' | 'beach';
export const PLAZA_BALLS: Partial<Record<PlazaSpotId, BallKind>> = { park: 'soccer', rooftop: 'soccer', beach: 'beach', garden: 'beach' };
export const BALL_PHYSICS: Record<BallKind, { bounce: number; groundFriction: number; airDrag: number; kick: number; lift: number; size: number }> = {
  // heavy: rolls far, low bounce
  soccer: { bounce: 0.5, groundFriction: 1.2, airDrag: 0.15, kick: 0.55, lift: 0.45, size: 22 },
  // light: pops up, floats, stops sooner
  beach: { bounce: 0.72, groundFriction: 2.6, airDrag: 2.2, kick: 0.45, lift: 0.8, size: 30 },
};
export const BALL_GRAVITY = 2.6;
export const BALL_MAX_SPEED = 1.6;
export const BALL_REST: Omit<PlazaBall, 'x' | 'y'> = { z: 0, vx: 0, vy: 0, vz: 0 };
export const ballStart = (): PlazaBall => ({ x: 0.5, y: 0.64, ...BALL_REST });

/** One physics step (dt seconds). Pure, and safe to run on the UI thread. */
export function stepBall(b: PlazaBall, kind: BallKind, dt: number): PlazaBall {
  'worklet';
  const p = BALL_PHYSICS[kind];
  let { x, y, z, vx, vy, vz } = b;
  // gravity and bounce off the ground
  vz -= BALL_GRAVITY * dt;
  z += vz * dt;
  if (z <= 0) {
    z = 0;
    vz = Math.abs(vz) > 0.08 ? -vz * p.bounce : 0;
  }
  // drag in the air, friction on the ground
  const k = Math.exp(-(z > 0.001 ? p.airDrag : p.groundFriction) * dt);
  vx *= k;
  vy *= k;
  x += vx * dt;
  y += vy * dt;
  // the floor's edges are walls
  if (x < PLAZA_FLOOR.minX) { x = PLAZA_FLOOR.minX; vx = Math.abs(vx) * p.bounce; }
  if (x > PLAZA_FLOOR.maxX) { x = PLAZA_FLOOR.maxX; vx = -Math.abs(vx) * p.bounce; }
  if (y < PLAZA_FLOOR.minY) { y = PLAZA_FLOOR.minY; vy = Math.abs(vy) * p.bounce; }
  if (y > PLAZA_FLOOR.maxY) { y = PLAZA_FLOOR.maxY; vy = -Math.abs(vy) * p.bounce; }
  if (z === 0 && vz === 0 && Math.hypot(vx, vy) < 0.004) { vx = 0; vy = 0; }
  return { x, y, z, vx, vy, vz };
}
export const ballMoving = (b: PlazaBall) => b.z > 0 || b.vz !== 0 || b.vx !== 0 || b.vy !== 0;

/** Where a ball kicked `ageMs` ago is now (same fixed steps as the live simulation). */
export function ballAfter(b: PlazaBall, kind: BallKind, ageMs: number): PlazaBall {
  let s = b;
  const steps = Math.min(Math.max(0, Math.round(ageMs / (1000 / 60))), 60 * 20);
  for (let i = 0; i < steps && ballMoving(s); i++) s = stepBall(s, kind, 1 / 60);
  return s;
}

/** Keep a kick physically sane (a modified client can't fire the ball across the world). */
export function sanitizeBall(b: PlazaBall): PlazaBall {
  const fin = (v: number) => (Number.isFinite(v) ? v : 0);
  const pos = clampToFloor(fin(b.x), fin(b.y));
  let vx = fin(b.vx);
  let vy = fin(b.vy);
  const sp = Math.hypot(vx, vy);
  if (sp > BALL_MAX_SPEED) { vx = (vx / sp) * BALL_MAX_SPEED; vy = (vy / sp) * BALL_MAX_SPEED; }
  return { x: pos.x, y: pos.y, z: Math.min(0.5, Math.max(0, fin(b.z))), vx, vy, vz: Math.min(1.5, Math.max(-1.5, fin(b.vz))) };
}
