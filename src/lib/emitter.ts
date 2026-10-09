import { Emitter } from '@socket.io/redis-emitter';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import type { ServiceEvents } from '../shared/types.js';

/**
 * Emit Socket.IO events from the API and the worker through Redis (doc section 1).
 * The realtime service's redis-adapter picks these up and delivers them to connected sockets.
 */
const emitter = new Emitter(new Redis(config.REDIS_URL));

type Ev = Exclude<keyof ServiceEvents, 'connection'>;

export const rooms = {
  user: (id: string) => `user:${id}`,
  conv: (id: string) => `conv:${id}`,
  room: (ownerId: string) => `room:${ownerId}`,
  /** Everyone looking at the public group list (live member counts). */
  discover: 'discover',
  /** Everyone in the Plaza tab (live spot counts). */
  plazaLobby: 'plaza-lobby',
};

export function toUser<E extends Ev>(userId: string, event: E, payload: ServiceEvents[E]) {
  emitter.to(rooms.user(userId)).emit(event, payload);
}
/** Drops every live connection a user has (used when an account is suspended). */
export function kickUser(userId: string) {
  emitter.in(rooms.user(userId)).disconnectSockets(true);
}
export function toUsers<E extends Ev>(userIds: string[], event: E, payload: ServiceEvents[E]) {
  if (userIds.length === 0) return;
  emitter.to(userIds.map(rooms.user)).emit(event, payload);
}
export function toRoom<E extends Ev>(room: string, event: E, payload: ServiceEvents[E]) {
  emitter.to(room).emit(event, payload);
}
