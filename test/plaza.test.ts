import { describe, expect, it } from 'vitest';
import { BALL_MAX_SPEED, PLAZA_FLOOR, ballAfter, ballMoving, ballStart, clampToFloor, sanitizeBall, stepBall } from '../src/shared/plaza.js';

const kicked = { ...ballStart(), vx: 0.8, vy: 0.2, vz: 0.6 };

describe('ball physics', () => {
  it('a kicked ball flies, lands, rolls and stops', () => {
    for (const kind of ['soccer', 'beach'] as const) {
      let b = kicked;
      let maxZ = 0;
      let t = 0;
      while (ballMoving(b) && t < 60 * 30) { b = stepBall(b, kind, 1 / 60); maxZ = Math.max(maxZ, b.z); t++; }
      expect(maxZ).toBeGreaterThan(0.02);
      expect(ballMoving(b)).toBe(false);
      expect(t).toBeLessThan(60 * 15);
      expect(b.x).toBeGreaterThan(kicked.x);
    }
  });
  it('the beach ball floats higher, the football rolls further', () => {
    const run = (kind: 'soccer' | 'beach') => {
      // Total path length (the football can reach a wall and bounce back).
      let b = kicked; let maxZ = 0; let dist = 0;
      for (let i = 0; i < 60 * 15 && ballMoving(b); i++) {
        const n = stepBall(b, kind, 1 / 60);
        dist += Math.hypot(n.x - b.x, n.y - b.y);
        maxZ = Math.max(maxZ, n.z);
        b = n;
      }
      return { maxZ, dist };
    };
    const s = run('soccer');
    const beach = run('beach');
    expect(s.dist).toBeGreaterThan(beach.dist);
  });
  it('never leaves the floor and never sinks below the ground', () => {
    let b = { ...ballStart(), vx: 1.6, vy: -1.6, vz: 1.2 };
    for (let i = 0; i < 600; i++) {
      b = stepBall(b, 'beach', 1 / 60);
      expect(b.x).toBeGreaterThanOrEqual(PLAZA_FLOOR.minX);
      expect(b.x).toBeLessThanOrEqual(PLAZA_FLOOR.maxX);
      expect(b.y).toBeGreaterThanOrEqual(PLAZA_FLOOR.minY);
      expect(b.y).toBeLessThanOrEqual(PLAZA_FLOOR.maxY);
      expect(b.z).toBeGreaterThanOrEqual(0);
    }
  });
  it('bounces back off a wall', () => {
    let b = { ...ballStart(), x: PLAZA_FLOOR.maxX - 0.01, vx: 1 };
    for (let i = 0; i < 10; i++) b = stepBall(b, 'soccer', 1 / 60);
    expect(b.vx).toBeLessThan(0);
  });
  it('a ball at rest stays at rest', () => {
    expect(stepBall(ballStart(), 'soccer', 1 / 60)).toEqual(ballStart());
  });
  it('catching up is deterministic (every phone agrees)', () => {
    expect(ballAfter(kicked, 'soccer', 1500)).toEqual(ballAfter(kicked, 'soccer', 1500));
    let live = kicked;
    for (let i = 0; i < 90; i++) live = stepBall(live, 'soccer', 1 / 60);
    expect(ballAfter(kicked, 'soccer', 1500)).toEqual(live);
  });
  it('a very old kick is just resting', () => {
    expect(ballMoving(ballAfter(kicked, 'beach', 10 * 60_000))).toBe(false);
  });
  it('sanitizes cheaty kicks', () => {
    const s = sanitizeBall({ x: 9, y: -9, z: 99, vx: 100, vy: 100, vz: 99 });
    expect(s).toMatchObject(clampToFloor(9, -9));
    expect(Math.hypot(s.vx, s.vy)).toBeCloseTo(BALL_MAX_SPEED);
    expect(s.z).toBe(0.5);
    expect(s.vz).toBe(1.5);
    expect(sanitizeBall({ x: NaN, y: Infinity, z: NaN, vx: NaN, vy: 0, vz: 0 }).vx).toBe(0);
  });
});
