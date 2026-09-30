import { createServer, type Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { config } from '../config.js';
import { memberIds, requireMember, summaryFor } from '../core/conversations.js';
import { SendBody, markWatermark, sendMessage } from '../core/messages.js';
import { presenceAudience } from '../core/users.js';
import { isApproved } from '../core/approval.js';
import { one, q } from '../db/pool.js';
import { rooms, toUsers } from '../lib/emitter.js';
import { AppError, publicValidationMessage } from '../lib/errors.js';
import { verifyAccess } from '../lib/jwt.js';
import { log } from '../lib/log.js';
import { ONLINE_SET, dropPresence, isOnline, touchPresence, viewingKey } from '../lib/presence.js';
import { redis } from '../lib/redis.js';
import { LIMITS } from '../shared/rules.js';
import type { RoomState, SendAck, StageOccupant } from '../shared/types.js';

const HEARTBEAT_MS = 25_000;
const ConvRef = z.object({ conversationId: z.string().uuid() });
const Watermark = ConvRef.extend({ upToSeq: z.number().int().min(0) });
const Hello = z.object({ conversations: z.array(z.object({ id: z.string().uuid(), maxSeq: z.number().int().min(0) })).max(50) });
const OwnerRef = z.object({ ownerId: z.string().uuid() });
const StageAction = z.object({
  conversationId: z.string().uuid(),
  action: z.enum(['walk', 'chair', 'jukebox', 'plant', 'coffee', 'nap', 'cheer', 'wave']),
  // Fractions of the floor (0..1) so positions line up on every screen width.
  targetX: z.number().min(0).max(1).optional(),
  targetY: z.number().min(0).max(1).optional(),
  isPlus: z.boolean().optional(),
  avatarEffect: z.enum(['fire', 'water', 'sparkle', 'nature', 'lightning', 'hearts']).optional(),
  avatarAnimation: z.enum(['float', 'bounce', 'spin', 'glide', 'zen']).optional(),
});


type S = Socket & { data: { userId: string; rooms: Set<string>; convs: Set<string> } };

// ---------------- typing (6 s TTL) ----------------
const typingKey = (c: string) => `typing:${c}`;
async function typingUsers(conversationId: string): Promise<string[]> {
  const now = Date.now();
  await redis.zremrangebyscore(typingKey(conversationId), 0, now);
  return redis.zrange(typingKey(conversationId), 0, -1);
}
async function setTyping(userId: string, conversationId: string, on: boolean) {
  if (on) {
    await redis.zadd(typingKey(conversationId), Date.now() + LIMITS.typingTtlS * 1000, userId);
    await redis.expire(typingKey(conversationId), LIMITS.typingTtlS * 2);
  } else {
    await redis.zrem(typingKey(conversationId), userId);
  }
  // Members' user rooms, so the chat list can show "Typing…" too.
  toUsers(await memberIds(conversationId), 'typing', { conversationId, userIds: await typingUsers(conversationId) });
}

// ---------------- companion rooms ----------------
const roomKey = (ownerId: string) => `roomstate:${ownerId}`;
async function roomState(ownerId: string): Promise<RoomState> {
  const [flags, visitors] = await Promise.all([redis.hgetall(roomKey(ownerId)), redis.hgetall(`${roomKey(ownerId)}:visitors`)]);
  return {
    ownerId, night: flags.night === '1', music: flags.music === '1',
    visitors: Object.values(visitors).map((v) => JSON.parse(v) as RoomState['visitors'][number]),
  };
}

// ---------------- chat avatar rooms ----------------
// stage:{conversationId} -> userId -> StageOccupant. Only people with the chat open are in it.
const stageKey = (c: string) => `stage:${c}`;
/** Seats one companion at a time; the rest (jukebox, plant, coffee) are shared spots. */
const SEATS = new Set<StageOccupant['action']>(['chair', 'nap']);

async function stageOccupants(conversationId: string): Promise<StageOccupant[]> {
  const raw = await redis.hgetall(stageKey(conversationId));
  const out: StageOccupant[] = [];
  const stale: string[] = [];
  await Promise.all(Object.entries(raw).map(async ([uid, v]) => {
    // A crashed server never ran disconnect cleanup; presence keys expire on their own, so trust those.
    if (!(await isOnline(uid))) { stale.push(uid); return; }
    try { out.push(JSON.parse(v) as StageOccupant); } catch { stale.push(uid); }
  }));
  if (stale.length) await redis.hdel(stageKey(conversationId), ...stale);
  return out;
}

async function broadcastPresence(userId: string, online: boolean) {
  const u = await one<{ last_seen_at: Date | null }>('SELECT last_seen_at FROM users WHERE id = $1', [userId]);
  toUsers(await presenceAudience(userId), 'presence', { userId, online, lastSeenAt: u?.last_seen_at?.toISOString() ?? null });
}

function wrap<T>(fn: () => Promise<T>) {
  return fn().catch((err: unknown) => {
    if (!(err instanceof AppError)) log.error({ err }, 'socket handler failed');
  });
}

/** Plain HTTP health check for the host (Render pings it); Socket.IO handles everything under /socket.io. */
const healthServer = () => createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (!req.url?.startsWith('/socket.io')) { res.writeHead(404); res.end(); }
});

/**
 * A clean disconnect announces "offline" right away. But when a phone dies, loses network without a close, or the
 * server restarts, no disconnect handler runs: the presence keys just expire (60 s) and nobody is told, so friends
 * kept seeing that person online. Every 20 s, anyone marked online whose keys have all expired is announced offline.
 * Safe with several realtime instances: SREM decides which one announces.
 */
function startPresenceSweeper() {
  const sweep = async () => {
    const ids = await redis.smembers(ONLINE_SET);
    for (const userId of ids) {
      if (await isOnline(userId)) continue;
      if ((await redis.srem(ONLINE_SET, userId)) === 0) continue;
      await q('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]);
      // Apps drop an offline user from every avatar room they show; the room lists also skip them on read.
      await broadcastPresence(userId, false);
    }
  };
  const timer = setInterval(() => { sweep().catch((err) => log.error({ err }, 'presence sweep failed')); }, 20_000);
  timer.unref?.();
}

export function createRealtime(httpServer: HttpServer = healthServer()) {
  const io = new Server(httpServer, {
    cors: { origin: config.CORS_ORIGINS === '*' ? true : config.CORS_ORIGINS.split(',') },
    pingInterval: HEARTBEAT_MS,
    pingTimeout: 20_000,
  });
  io.adapter(createAdapter(new Redis(config.REDIS_URL), new Redis(config.REDIS_URL)));
  startPresenceSweeper();

  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
      socket.data.userId = await verifyAccess(token);
      // Invite-only: no realtime (chat, presence) until the account is approved.
      if (!(await isApproved(socket.data.userId))) return next(new Error('approval pending'));
      next();
    } catch {
      next(new Error('unauthorized: invalid token'));
    }
  });

  io.on('connection', async (raw) => {
    const socket = raw as S;
    const userId = socket.data.userId;
    socket.data.rooms = new Set();
    socket.data.convs = new Set();
    await socket.join(rooms.user(userId));

    const wasOnline = await isOnline(userId);
    await touchPresence(userId, socket.id);
    if (!wasOnline) await broadcastPresence(userId, true);
    const beat = setInterval(() => { void touchPresence(userId, socket.id); }, HEARTBEAT_MS);

    // ---- messages ----
    socket.on('msg:send', async (input: unknown, ack?: (a: SendAck) => void) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const msg = await sendMessage(userId, SendBody.parse(input));
        reply({ ok: true, id: msg.id, seq: msg.seq, createdAt: msg.createdAt, message: msg });
      } catch (err) {
        if (err instanceof AppError) reply({ ok: false, code: err.code, message: err.message });
        else if (err instanceof z.ZodError) reply({ ok: false, code: 'BAD_REQUEST', message: publicValidationMessage(err.issues) });
        else { log.error({ err }, 'msg:send failed'); reply({ ok: false, code: 'INTERNAL', message: 'Could not send' }); }
      }
    });
    socket.on('msg:delivered', (p: unknown) => wrap(async () => { const w = Watermark.parse(p); await markWatermark(userId, w.conversationId, w.upToSeq, 'delivered'); }));
    socket.on('msg:read', (p: unknown) => wrap(async () => { const w = Watermark.parse(p); await markWatermark(userId, w.conversationId, w.upToSeq, 'read'); }));

    // ---- open chat ----
    socket.on('conv:join', (p: unknown) => wrap(async () => {
      const { conversationId } = ConvRef.parse(p);
      await requireMember(userId, conversationId);
      await socket.join(rooms.conv(conversationId));
      socket.data.convs.add(conversationId);
      await redis.hset(viewingKey(conversationId), userId, socket.id);
      // Enter the chat's avatar room (keeping a spot held from another device) and tell everyone who's here.
      const key = stageKey(conversationId);
      if (!(await redis.hexists(key, userId))) await redis.hset(key, userId, JSON.stringify({ userId } satisfies StageOccupant));
      await redis.expire(key, 24 * 60 * 60);
      await emitStage(conversationId);
    }));
    socket.on('conv:leave', (p: unknown) => wrap(async () => {
      const { conversationId } = ConvRef.parse(p);
      await socket.leave(rooms.conv(conversationId));
      socket.data.convs.delete(conversationId);
      await leaveStage(conversationId);
      await redis.hdel(viewingKey(conversationId), userId);
      await setTyping(userId, conversationId, false);
    }));

    // ---- typing ----
    socket.on('typing:start', (p: unknown) => wrap(async () => {
      const { conversationId } = ConvRef.parse(p);
      await requireMember(userId, conversationId);
      await setTyping(userId, conversationId, true);
    }));
    socket.on('typing:stop', (p: unknown) => wrap(async () => { await setTyping(userId, ConvRef.parse(p).conversationId, false); }));

    // ---- reconnect sync (doc 6.9) ----
    socket.on('sync:hello', (p: unknown) => wrap(async () => {
      const { conversations } = Hello.parse(p);
      if (conversations.length === 0) return;
      const rows = await q<{ id: string; last_seq: number }>(
        `SELECT c.id, c.last_seq FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = $1 WHERE c.id = ANY($2::uuid[])`,
        [userId, conversations.map((c) => c.id)],
      );
      const known = new Map(conversations.map((c) => [c.id, c.maxSeq]));
      for (const r of rows) {
        if (r.last_seq <= (known.get(r.id) ?? 0)) continue;
        const s = await summaryFor(userId, r.id);
        if (s) socket.emit('conv:update', { id: s.id, lastSeq: s.lastSeq, lastMessagePreview: s.lastMessagePreview, lastMessageAt: s.lastMessageAt, unread: s.unread, summary: s });
      }
    }));

    
    // ---- chat avatar room ----
    const emitStage = async (conversationId: string) => {
      io.to(rooms.conv(conversationId)).emit('stage:presence', { conversationId, occupants: await stageOccupants(conversationId) });
    };
    /** Leaves the room only if this socket is the one holding the user's spot (another device may have taken over). */
    const leaveStage = async (conversationId: string) => {
      if ((await redis.hget(viewingKey(conversationId), userId)) !== socket.id) return;
      await redis.hdel(stageKey(conversationId), userId);
      await emitStage(conversationId);
    };

    socket.on('stage:action', (p: unknown) => wrap(async () => {
      const { conversationId, action, targetX, targetY, isPlus, avatarEffect, avatarAnimation } = StageAction.parse(p);
      // Only people who have the chat open are in its room (conv:join already checked membership).
      if (!socket.data.convs.has(conversationId)) return;
      const key = stageKey(conversationId);
      const prevRaw = await redis.hget(key, userId);
      const prev: StageOccupant = prevRaw ? JSON.parse(prevRaw) as StageOccupant : { userId };
      if (SEATS.has(action)) {
        const taken = (await stageOccupants(conversationId)).some((o) => o.userId !== userId && o.action === action);
        // Someone got there first: resync this client so its companion stays put.
        if (taken) { socket.emit('stage:presence', { conversationId, occupants: await stageOccupants(conversationId) }); return; }
      }
      // cheer / wave are gestures, not moves: the companion stays where (and how) it was.
      if (action !== 'cheer' && action !== 'wave') {
        const next: StageOccupant = { userId, action, targetX, targetY, isPlus, avatarEffect, avatarAnimation };
        await redis.hset(key, userId, JSON.stringify(next));
        await redis.expire(key, 24 * 60 * 60);
        if (SEATS.has(action) || SEATS.has(prev.action)) await emitStage(conversationId);
      }
      io.to(rooms.conv(conversationId)).emit('stage:action', {
        conversationId,
        userId,
        action,
        targetX,
        targetY,
        isPlus,
        avatarEffect,
        avatarAnimation,
      });
    }));

    // ---- companion rooms ----
    socket.on('room:join', (p: unknown) => wrap(async () => {
      const { ownerId } = OwnerRef.parse(p);
      await socket.join(rooms.room(ownerId));
      socket.data.rooms.add(ownerId);
      if (ownerId !== userId) {
        const v = await one<{ display_name: string; palette: string; equipped_outfit: string }>(
          'SELECT u.display_name, c.palette, c.equipped_outfit FROM users u JOIN companions c ON c.user_id = u.id WHERE u.id = $1', [userId],
        );
        if (v) await redis.hset(`${roomKey(ownerId)}:visitors`, userId, JSON.stringify({ userId, palette: v.palette, outfit: v.equipped_outfit, name: v.display_name }));
      }
      io.to(rooms.room(ownerId)).emit('room:state', await roomState(ownerId));
    }));
    socket.on('room:leave', (p: unknown) => wrap(async () => {
      const { ownerId } = OwnerRef.parse(p);
      await socket.leave(rooms.room(ownerId));
      socket.data.rooms.delete(ownerId);
      await redis.hdel(`${roomKey(ownerId)}:visitors`, userId);
      io.to(rooms.room(ownerId)).emit('room:state', await roomState(ownerId));
    }));
    socket.on('room:set', (p: unknown) => wrap(async () => {
      // Only the owner changes their own room.
      const b = z.object({ night: z.boolean().optional(), music: z.boolean().optional() }).parse(p);
      if (b.night !== undefined) await redis.hset(roomKey(userId), 'night', b.night ? '1' : '0');
      if (b.music !== undefined) await redis.hset(roomKey(userId), 'music', b.music ? '1' : '0');
      io.to(rooms.room(userId)).emit('room:state', await roomState(userId));
    }));

    socket.on('disconnect', async () => {
      clearInterval(beat);
      await dropPresence(userId, socket.id);
      for (const c of socket.data.convs) {
        await leaveStage(c).catch(() => {});
        if ((await redis.hget(viewingKey(c), userId)) === socket.id) await redis.hdel(viewingKey(c), userId);
        await setTyping(userId, c, false).catch(() => {});
      }
      for (const ownerId of socket.data.rooms) {
        await redis.hdel(`${roomKey(ownerId)}:visitors`, userId);
        io.to(rooms.room(ownerId)).emit('room:state', await roomState(ownerId));
      }
      if (!(await isOnline(userId))) {
        await redis.srem(ONLINE_SET, userId);
        await q('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]);
        await broadcastPresence(userId, false);
      }
    });
  });

  return { io, httpServer };
}
