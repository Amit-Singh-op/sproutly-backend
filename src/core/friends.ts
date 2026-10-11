/**
 * Friend requests. Adding someone sends a request (one 'pending' row, sender -> receiver); they accept (both rows
 * become 'accepted') or decline. If they had already asked you, adding them back just accepts. Blocks win over
 * everything. Each change tells both people's apps (`friends:update`) and the receiver gets a notification.
 */
import { one, q, tx } from '../db/pool.js';
import { toUsers } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { log } from '../lib/log.js';
import { onlineMap } from '../lib/presence.js';
import { initialsOf } from '../shared/rules.js';
import type { FriendRelation, FriendRequests, Person } from '../shared/types.js';
import { notifyActivity } from './activity.js';

type Row = { user_id: string; friend_id: string; status: 'pending' | 'accepted' | 'blocked' };

/**
 * Can `sender` message `recipient` privately? null = yes; otherwise the reason, as the person reading it should
 * see it. Blocks either way stop it; a recipient who only takes messages from friends needs you to be friends.
 */
export async function dmBlockedReason(sender: string, recipient: string): Promise<string | null> {
  const [rel, r] = await Promise.all([
    relation(sender, recipient),
    one<{ dm_policy: 'everyone' | 'friends'; display_name: string }>('SELECT dm_policy, display_name FROM users WHERE id = $1', [recipient]),
  ]);
  if (rel === 'blocked') return 'You can’t message this person';
  if (r?.dm_policy === 'friends' && rel !== 'friends') {
    const first = (r.display_name || 'They').split(' ')[0];
    return rel === 'outgoing'
      ? `${first} only gets messages from friends. You can chat once they accept your friend request.`
      : `${first} only gets messages from friends. Send a friend request to start chatting.`;
  }
  return null;
}

/** How `me` and `other` are connected. */
export async function relation(me: string, other: string): Promise<FriendRelation> {
  if (me === other) return 'self';
  const rows = await q<Row>(
    `SELECT user_id, friend_id, status FROM friendships WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`, [me, other]);
  return relationFrom(me, rows);
}

function relationFrom(me: string, rows: Row[]): FriendRelation {
  if (rows.some((r) => r.status === 'blocked')) return 'blocked';
  if (rows.some((r) => r.status === 'accepted')) return 'friends';
  if (rows.some((r) => r.status === 'pending' && r.user_id === me)) return 'outgoing';
  if (rows.some((r) => r.status === 'pending' && r.friend_id === me)) return 'incoming';
  return 'none';
}

/** Relations to many people at once (search results, lists). */
export async function relations(me: string, others: string[]): Promise<Record<string, FriendRelation>> {
  const out: Record<string, FriendRelation> = {};
  if (others.length === 0) return out;
  const rows = await q<Row>(
    `SELECT user_id, friend_id, status FROM friendships
      WHERE (user_id = $1 AND friend_id = ANY($2::uuid[])) OR (friend_id = $1 AND user_id = ANY($2::uuid[]))`, [me, others]);
  for (const id of others) out[id] = id === me ? 'self' : relationFrom(me, rows.filter((r) => r.user_id === id || r.friend_id === id));
  return out;
}

export async function nameOf(id: string) {
  return (await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [id]))?.display_name ?? 'Someone';
}

/** Queue a phone notification for one person (best effort). */
export function notifyPush(userId: string, title: string, body: string, data: Record<string, string>, ref: string) {
  enqueue.push(ref, { kind: 'social', userId, title, body, data }).catch((err: unknown) => log.warn({ err: (err as Error).message }, 'social push enqueue failed'));
}

/** Add friend: sends a request, or accepts theirs if they already asked. Returns the new relation. */
export async function requestFriend(me: string, other: string): Promise<FriendRelation> {
  if (me === other) throw E.badRequest("You can't add yourself");
  if (!(await one('SELECT 1 FROM users WHERE id = $1 AND suspended_at IS NULL', [other]))) throw E.notFound('User not found');
  const now = await relation(me, other);
  if (now === 'blocked') throw E.forbidden("You can't add this person");
  if (now === 'friends' || now === 'outgoing') return now;
  if (now === 'incoming') return acceptFriend(me, other);
  // Lots of requests waiting on people who never answer looks like spam: cap how many can be open.
  const open = await one<{ n: string }>(`SELECT COUNT(*) AS n FROM friendships WHERE user_id = $1 AND status = 'pending'`, [me]);
  if (Number(open?.n ?? 0) >= 100) throw new AppError(429, 'RATE_LIMITED', 'You have a lot of friend requests waiting. Give people time to answer.');
  await q(`INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'pending') ON CONFLICT (user_id, friend_id) DO NOTHING`, [me, other]);
  toUsers([me, other], 'friends:update', { userId: me });
  const name = await nameOf(me);
  const ref = `freq:${me}:${other}:${Date.now()}`;
  await notifyActivity([other], me, 'friend_request', {}, ref);
  notifyPush(other, 'Friend request', `${name} wants to be friends`, { type: 'friends' }, ref);
  return 'outgoing';
}

export async function acceptFriend(me: string, other: string): Promise<FriendRelation> {
  const done = await tx(async (c) => {
    const req = await one(`SELECT 1 FROM friendships WHERE user_id = $1 AND friend_id = $2 AND status = 'pending' FOR UPDATE`, [other, me], c);
    if (!req) return false;
    await q(
      `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1, $2, 'accepted'), ($2, $1, 'accepted')
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'accepted' WHERE friendships.status <> 'blocked'`, [me, other], c);
    return true;
  });
  if (!done) {
    const now = await relation(me, other);
    if (now === 'friends') return now;
    throw E.notFound('That friend request is no longer there');
  }
  toUsers([me, other], 'friends:update', { userId: me });
  // Both sides' story rings, presence and feeds now include each other.
  toUsers([me, other], 'social:update', { userId: me });
  const name = await nameOf(me);
  const ref = `facc:${me}:${other}:${Date.now()}`;
  await notifyActivity([other], me, 'friend_accept', {}, ref);
  notifyPush(other, 'New friend', `${name} accepted your friend request`, { type: 'friends' }, ref);
  return 'friends';
}

/** Decline a request someone sent you (they aren't told; it just disappears). */
export async function declineFriend(me: string, other: string) {
  await q(`DELETE FROM friendships WHERE user_id = $1 AND friend_id = $2 AND status = 'pending'`, [other, me]);
  toUsers([me, other], 'friends:update', { userId: me });
}

/** Unfriend, or cancel a request you sent. */
export async function removeFriendOrRequest(me: string, other: string) {
  await q(
    `DELETE FROM friendships WHERE (status = 'accepted' AND ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)))
        OR (status = 'pending' AND user_id = $1 AND friend_id = $2)`, [me, other]);
  toUsers([me, other], 'friends:update', { userId: me });
  toUsers([me, other], 'social:update', { userId: me });
}

type PRow = { id: string; display_name: string; handle: string; avatar_color: string; avatar_url: string | null; created_at: Date };

export async function friendRequests(me: string): Promise<FriendRequests> {
  const select = 'SELECT u.id, u.display_name, u.handle, u.avatar_color, u.avatar_url, f.created_at FROM friendships f JOIN users u ON u.id =';
  const [incoming, outgoing] = await Promise.all([
    q<PRow>(`${select} f.user_id WHERE f.friend_id = $1 AND f.status = 'pending' AND u.suspended_at IS NULL ORDER BY f.created_at DESC LIMIT 100`, [me]),
    q<PRow>(`${select} f.friend_id WHERE f.user_id = $1 AND f.status = 'pending' AND u.suspended_at IS NULL ORDER BY f.created_at DESC LIMIT 100`, [me]),
  ]);
  const online = await onlineMap([...incoming, ...outgoing].map((r) => r.id));
  const toP = (rel: 'incoming' | 'outgoing') => (r: PRow): Person & { requestedAt: string } => ({
    id: r.id, displayName: r.display_name, handle: r.handle, avatarColor: r.avatar_color, avatarUrl: r.avatar_url,
    initials: initialsOf(r.display_name), online: online[r.id] ?? false, relation: rel, requestedAt: r.created_at.toISOString(),
  });
  return { incoming: incoming.map(toP('incoming')), outgoing: outgoing.map(toP('outgoing')) };
}
