/**
 * Group chats have no member limit; what's limited is how many members are *in* the chat at the same moment.
 * Opening a group chat takes a "live seat" (live:{conversationId} -> userId -> holder), atomically, so two people
 * opening it at the same time can never both take the last seat. Seats are freed when the chat is closed, the app
 * is closed, or the connection dies (seats of people who are no longer online are cleared on the next read).
 * Every group allows ROOM_LIVE_CAPACITY (25) people in at once, the same as its avatar room's seats.
 */
import { one } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { isOnline } from '../lib/presence.js';
import { redis } from '../lib/redis.js';
import { takeSeat } from '../lib/seats.js';
import { ROOM_LIVE_CAPACITY } from '../shared/types.js';

const liveKey = (id: string) => `live:${id}`;
const TTL_S = 12 * 60 * 60;
const CAP_CACHE_MS = 60_000;
const capCache = new Map<string, { at: number; cap: number | null }>();

/** How many can be in the chat at once: ROOM_LIVE_CAPACITY for groups, null (no limit) for DMs. */
export async function groupCapacity(conversationId: string): Promise<number | null> {
  const hit = capCache.get(conversationId);
  if (hit && Date.now() - hit.at < CAP_CACHE_MS) return hit.cap;
  const c = await one<{ kind: string }>('SELECT kind FROM conversations WHERE id = $1', [conversationId]);
  const cap = c?.kind === 'group' ? ROOM_LIVE_CAPACITY : null;
  capCache.set(conversationId, { at: Date.now(), cap });
  return cap;
}

/** Drop seats whose holder is no longer online (crashed app, lost connection) and return how many are taken. */
export async function liveCount(conversationId: string): Promise<number> {
  const seats = await redis.hkeys(liveKey(conversationId));
  if (seats.length === 0) return 0;
  const online = await Promise.all(seats.map((u) => isOnline(u)));
  const stale = seats.filter((_, i) => !online[i]);
  if (stale.length) await redis.hdel(liveKey(conversationId), ...stale);
  return seats.length - stale.length;
}

/** Quick counts for lists (no clean-up pass; good enough for a badge, exact on the next join or leave). */
export async function liveCounts(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const p = redis.pipeline();
  for (const id of ids) p.hlen(liveKey(id));
  const res = (await p.exec()) ?? [];
  return Object.fromEntries(ids.map((id, i) => [id, Number(res[i]?.[1] ?? 0)]));
}

/**
 * Take a seat in a group chat. `holder` is the socket holding it (a second device just takes the seat over).
 * Returns ok=false when the group is full right now.
 */
export async function takeLiveSeat(userId: string, conversationId: string, holder: string): Promise<{ ok: boolean; count: number; capacity: number | null }> {
  const capacity = await groupCapacity(conversationId);
  if (capacity === null) return { ok: true, count: 0, capacity: null };
  await liveCount(conversationId); // free seats held by people who aren't online any more
  const ok = await takeSeat(liveKey(conversationId), userId, holder, capacity);
  if (ok) await redis.expire(liveKey(conversationId), TTL_S);
  return { ok, count: await redis.hlen(liveKey(conversationId)), capacity };
}

/** Give the seat back, but only if `holder` still holds it (another device may have taken it over). */
export async function leaveLiveSeat(userId: string, conversationId: string, holder: string): Promise<boolean> {
  if ((await redis.hget(liveKey(conversationId), userId)) !== holder) return false;
  await redis.hdel(liveKey(conversationId), userId);
  return true;
}

/**
 * Sending in a group needs a seat (so the at-once limit can't be side-stepped). Someone sending without the chat open
 * on a socket (the REST fallback) takes a seat if there's room.
 */
export async function requireLiveSeat(userId: string, conversationId: string) {
  if ((await groupCapacity(conversationId)) === null) return;
  if (await redis.hexists(liveKey(conversationId), userId)) return;
  const r = await takeLiveSeat(userId, conversationId, 'rest');
  if (!r.ok) throw new AppError(403, 'ROOM_FULL', `This group is full right now (${r.capacity} online). You'll get in as soon as someone leaves.`);
}

/** Everyone currently in a group chat (for clean-up on account deletion and tests). */
export async function liveMembers(conversationId: string): Promise<string[]> {
  return redis.hkeys(liveKey(conversationId));
}

