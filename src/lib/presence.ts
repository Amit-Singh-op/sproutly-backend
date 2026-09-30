import { LIMITS } from '../shared/rules.js';
import { redis } from './redis.js';

/** presence:{userId}:{socketId} with a 60 s TTL, refreshed by the socket heartbeat. Online = at least one key. */
/** Everyone we've told the world is online; the sweeper checks them so nobody stays "online" after a hard exit. */
export const ONLINE_SET = 'presence:online-users';

export async function touchPresence(userId: string, socketId: string) {
  await redis.set(`presence:${userId}:${socketId}`, '1', 'EX', LIMITS.presenceTtlS);
  await redis.sadd(ONLINE_SET, userId);
  await redis.sadd(`presence-sockets:${userId}`, socketId);
  await redis.expire(`presence-sockets:${userId}`, LIMITS.presenceTtlS * 2);
}

export async function dropPresence(userId: string, socketId: string) {
  await redis.del(`presence:${userId}:${socketId}`);
  await redis.srem(`presence-sockets:${userId}`, socketId);
}

export async function isOnline(userId: string): Promise<boolean> {
  const sockets = await redis.smembers(`presence-sockets:${userId}`);
  if (sockets.length === 0) return false;
  const alive = await redis.exists(...sockets.map((s) => `presence:${userId}:${s}`));
  return alive > 0;
}

export async function onlineMap(userIds: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  await Promise.all(userIds.map(async (u) => { out[u] = await isOnline(u); }));
  return out;
}

/** Sockets currently viewing a conversation (used by push: skip members who have the chat open). */
export const viewingKey = (conversationId: string) => `viewing:${conversationId}`;
export async function isViewing(conversationId: string, userId: string) {
  return (await redis.hexists(viewingKey(conversationId), userId)) === 1;
}
