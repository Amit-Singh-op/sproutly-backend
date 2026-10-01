/**
 * Plaza: public hangout spots (café, park, beach…). Who's in a spot lives in Redis (plaza:{spot} -> userId -> occupant),
 * so several realtime instances share it. You're in at most one spot, on one device (the last one to enter wins).
 * Local chat lines are never written to the database: the last few sit in Redis for 10 minutes so arrivals see them.
 * People who blocked each other (either way) never see each other's companions, moves, emotes or lines.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { one, q } from '../db/pool.js';
import { log } from '../lib/log.js';
import { isOnline } from '../lib/presence.js';
import { redis } from '../lib/redis.js';
import {
  PLAZA_CAPACITY, PLAZA_EMOTES, PLAZA_HISTORY, PLAZA_HISTORY_TTL_S, PLAZA_LIMITS, PLAZA_SAY_MAX, PLAZA_SPOT_IDS,
  arrivalPoint, clampToFloor,
} from '../shared/plaza.js';
import { cleanText } from '../shared/rules.js';
import { recordSocialQuest } from '../core/companion.js';
import type { PlazaEnterResult, PlazaLine, PlazaOccupant, PlazaSpotId, PlazaSpotInfo, PlazaState } from '../shared/types.js';

const spotKey = (s: PlazaSpotId) => `plaza:${s}`;
const linesKey = (s: PlazaSpotId) => `plaza:lines:${s}`;
const roomOf = (s: PlazaSpotId) => `plaza-room:${s}`;
const TTL_S = 6 * 60 * 60;

const Spot = z.object({ spot: z.enum(PLAZA_SPOT_IDS) });
const Move = z.object({ x: z.number(), y: z.number() });
const Emote = z.object({ emote: z.enum(PLAZA_EMOTES as [string, ...string[]]) });
const Say = z.object({ text: z.string().min(1).max(PLAZA_SAY_MAX * 2) });

export interface PlazaSocketData { plazaSpot?: PlazaSpotId; plazaBlocked?: string[]; plazaMoveAt?: number; plazaEmoteAt?: number }
type PS = Socket & { data: { userId: string } & PlazaSocketData };

/** Everyone in the spot who's still really online (a crashed server never cleaned up; presence keys expire). */
async function occupants(spot: PlazaSpotId): Promise<PlazaOccupant[]> {
  const raw = await redis.hgetall(spotKey(spot));
  const out: PlazaOccupant[] = [];
  const stale: string[] = [];
  await Promise.all(Object.entries(raw).map(async ([uid, v]) => {
    if (!(await isOnline(uid))) { stale.push(uid); return; }
    try { out.push(JSON.parse(v) as PlazaOccupant); } catch { stale.push(uid); }
  }));
  if (stale.length) await redis.hdel(spotKey(spot), ...stale);
  return out;
}

/** GET /plaza/spots: how many are in each spot right now (for the spot picker). */
export async function plazaSpots(): Promise<PlazaSpotInfo[]> {
  return Promise.all(PLAZA_SPOT_IDS.map(async (id) => {
    const count = (await occupants(id)).length;
    return { id, count, full: count >= PLAZA_CAPACITY };
  }));
}

async function blockedEitherWay(userId: string): Promise<string[]> {
  const rows = await q<{ id: string }>(
    `SELECT friend_id AS id FROM friendships WHERE user_id = $1 AND status = 'blocked'
     UNION SELECT user_id FROM friendships WHERE friend_id = $1 AND status = 'blocked'`, [userId],
  );
  return rows.map((r) => r.id);
}

/** Send to everyone in the spot except people with a block either way with `actorId`. */
async function toSpot(io: Server, spot: PlazaSpotId, actorId: string, event: string, payload: unknown, exceptSocket?: string) {
  const sockets = await io.in(roomOf(spot)).fetchSockets();
  for (const s of sockets) {
    if (s.id === exceptSocket) continue;
    const d = s.data as { userId: string } & PlazaSocketData;
    if (d.userId === actorId && event !== 'plaza:say') continue;
    if (d.plazaBlocked?.includes(actorId)) continue;
    s.emit(event, payload);
  }
}

export function registerPlaza(io: Server, raw: Socket) {
  const socket = raw as PS;
  const userId = socket.data.userId;
  let sayTimes: number[] = [];

  const leave = async () => {
    const spot = socket.data.plazaSpot;
    if (!spot) return;
    socket.data.plazaSpot = undefined;
    await socket.leave(roomOf(spot));
    // Only drop the occupant if this socket still holds it (another device may have entered since).
    if ((await redis.get(`plaza:at:${userId}`)) === socket.id) {
      await redis.del(`plaza:at:${userId}`);
      await redis.hdel(spotKey(spot), userId);
      await toSpot(io, spot, userId, 'plaza:leave', { spot, userId });
    }
  };

  socket.on('plaza:enter', (p: unknown, ack?: (r: PlazaEnterResult) => void) => {
    const reply = (r: PlazaEnterResult) => { if (typeof ack === 'function') ack(r); };
    void (async () => {
      const { spot } = Spot.parse(p);
      if (socket.data.plazaSpot && socket.data.plazaSpot !== spot) await leave();
      const here = await occupants(spot);
      const already = here.some((o) => o.userId === userId);
      if (!already && here.length >= PLAZA_CAPACITY) return reply({ ok: false, code: 'FULL', message: 'This spot is full right now. Try another one!' });

      const u = await one<{ display_name: string; palette: PlazaOccupant['palette']; equipped_outfit: PlazaOccupant['outfit']; level: number; plus: boolean }>(
        `SELECT u.display_name, c.palette, c.equipped_outfit, c.level, COALESCE(e.plus_active, FALSE) AS plus
           FROM users u JOIN companions c ON c.user_id = u.id LEFT JOIN entitlements e ON e.user_id = u.id WHERE u.id = $1`, [userId],
      );
      if (!u) return reply({ ok: false, code: 'ERROR', message: 'Could not join the Plaza' });

      // You're only ever in one spot: a different device or spot hands over to this socket.
      for (const s of PLAZA_SPOT_IDS) if (s !== spot) await redis.hdel(spotKey(s), userId);
      await redis.set(`plaza:at:${userId}`, socket.id, 'EX', TTL_S);

      const pos = already ? here.find((o) => o.userId === userId)! : arrivalPoint(() => randomInt(1_000_000) / 1_000_000);
      const me: PlazaOccupant = { userId, name: u.display_name, palette: u.palette, outfit: u.equipped_outfit, level: u.level, isPlus: u.plus, x: pos.x, y: pos.y };
      await redis.hset(spotKey(spot), userId, JSON.stringify(me));
      await redis.expire(spotKey(spot), TTL_S);

      socket.data.plazaBlocked = await blockedEitherWay(userId);
      socket.data.plazaSpot = spot;
      await socket.join(roomOf(spot));

      const blocked = new Set(socket.data.plazaBlocked);
      const lines = (await redis.lrange(linesKey(spot), 0, PLAZA_HISTORY - 1))
        .map((l) => { try { return JSON.parse(l) as PlazaLine; } catch { return null; } })
        .filter((l): l is PlazaLine => !!l && !blocked.has(l.userId))
        .reverse();
      const state: PlazaState = { spot, occupants: [...here.filter((o) => o.userId !== userId && !blocked.has(o.userId)), me], lines };
      reply({ ok: true, state });
      await toSpot(io, spot, userId, 'plaza:join', { spot, occupant: me }, socket.id);
    })().catch((err) => {
      if (!(err instanceof z.ZodError)) log.error({ err }, 'plaza:enter failed');
      reply({ ok: false, code: 'ERROR', message: 'Could not join the Plaza' });
    });
  });

  socket.on('plaza:leave', () => { leave().catch((err) => log.error({ err }, 'plaza:leave failed')); });

  socket.on('plaza:move', (p: unknown) => {
    void (async () => {
      const spot = socket.data.plazaSpot;
      if (!spot) return;
      const now = Date.now();
      if (now - (socket.data.plazaMoveAt ?? 0) < PLAZA_LIMITS.moveMs) return;
      socket.data.plazaMoveAt = now;
      const m = Move.parse(p);
      const { x, y } = clampToFloor(m.x, m.y);
      const prev = await redis.hget(spotKey(spot), userId);
      if (!prev) return;
      await redis.hset(spotKey(spot), userId, JSON.stringify({ ...(JSON.parse(prev) as PlazaOccupant), x, y }));
      await toSpot(io, spot, userId, 'plaza:move', { spot, userId, x, y });
    })().catch(() => {});
  });

  socket.on('plaza:emote', (p: unknown) => {
    void (async () => {
      const spot = socket.data.plazaSpot;
      if (!spot) return;
      const now = Date.now();
      if (now - (socket.data.plazaEmoteAt ?? 0) < PLAZA_LIMITS.emoteMs) return;
      socket.data.plazaEmoteAt = now;
      const { emote } = Emote.parse(p);
      await toSpot(io, spot, userId, 'plaza:emote', { spot, userId, emote });
      // Daily "wave at someone in the Plaza" quest: a wave counts when somebody else is here to see it.
      if (emote === 'wave' && (await redis.hlen(spotKey(spot))) > 1) await recordSocialQuest(userId, 'plaza');
    })().catch(() => {});
  });

  socket.on('plaza:say', (p: unknown, ack?: (r: { ok: boolean; message?: string }) => void) => {
    const reply = (r: { ok: boolean; message?: string }) => { if (typeof ack === 'function') ack(r); };
    void (async () => {
      const spot = socket.data.plazaSpot;
      if (!spot) return reply({ ok: false, message: 'Join a spot first' });
      const now = Date.now();
      sayTimes = sayTimes.filter((t) => now - t < PLAZA_LIMITS.say.windowS * 1000);
      if (sayTimes.length >= PLAZA_LIMITS.say.points) return reply({ ok: false, message: 'Slow down a little 🙂' });
      const text = cleanText(Say.parse(p).text).replace(/\s+/g, ' ').slice(0, PLAZA_SAY_MAX);
      if (!text) return reply({ ok: false });
      sayTimes.push(now);
      const name = (await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [userId]))?.display_name ?? 'Someone';
      const line: PlazaLine = { id: randomUUID(), userId, name, text, at: new Date(now).toISOString() };
      await redis.lpush(linesKey(spot), JSON.stringify(line));
      await redis.ltrim(linesKey(spot), 0, PLAZA_HISTORY - 1);
      await redis.expire(linesKey(spot), PLAZA_HISTORY_TTL_S);
      await toSpot(io, spot, userId, 'plaza:say', { spot, line });
      reply({ ok: true });
    })().catch(() => reply({ ok: false, message: 'Could not send' }));
  });

  socket.on('disconnect', () => { leave().catch(() => {}); });
}
