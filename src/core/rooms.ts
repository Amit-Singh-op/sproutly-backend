import { one, q, tx } from '../db/pool.js';
import { toUsers } from '../lib/emitter.js';
import { initialsOf } from '../shared/rules.js';
import type { RoomInvite } from '../shared/types.js';
import { E } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { localDay } from '../lib/time.js';
import type { RoomInfo } from '../shared/types.js';
import { isPlus, requirePlus } from './entitlements.js';
import { getCompanion, isBlocked } from './users.js';

const PLUS_DECOR = ['string_lights', 'gold_trophy', 'bean_bag'];

export async function getRoom(viewerId: string, ownerId: string): Promise<RoomInfo> {
  const owner = await one<{ id: string; display_name: string }>('SELECT id, display_name FROM users WHERE id = $1', [ownerId]);
  if (!owner) throw E.notFound('Room not found');
  if (viewerId !== ownerId && (await isBlocked(viewerId, ownerId))) throw E.notFound('Room not found');
  const plus = await isPlus(ownerId);
  const companion = await getCompanion(ownerId);
  return {
    ownerId, ownerName: owner.display_name, companion: { ...companion, roomTheme: plus ? 'cabin' : 'basic' },
    theme: plus ? 'cabin' : 'basic', decor: plus ? PLUS_DECOR : [],
  };
}

/** Plus to invite. */
export async function invite(hostId: string, guestId: string) {
  await requirePlus(hostId, 'room_invite');
  if (hostId === guestId) throw E.badRequest("You can't invite yourself");
  if (!(await one('SELECT 1 FROM users WHERE id = $1', [guestId]))) throw E.notFound('User not found');
  if (await isBlocked(hostId, guestId)) throw E.forbidden();
  // One pending invite per pair: inviting again just refreshes it (no notification spam).
  const pending = await one<{ id: string }>(
    `UPDATE room_invites SET created_at = now() WHERE host_id = $1 AND guest_id = $2 AND status = 'pending' AND created_at > now() - interval '7 days' RETURNING id`,
    [hostId, guestId],
  );
  if (pending) return { id: pending.id };
  const inv = await one<{ id: string }>(
    `INSERT INTO room_invites (host_id, guest_id) VALUES ($1,$2) RETURNING id`, [hostId, guestId],
  );
  await enqueue.push(`invite:${inv!.id}`, { kind: 'invite', inviteId: inv!.id });
  toUsers([guestId], 'invites:update', {});
  return { id: inv!.id };
}

export async function respond(guestId: string, inviteId: string, accept: boolean) {
  const r = await one<{ host_id: string }>('UPDATE room_invites SET status = $3 WHERE id = $1 AND guest_id = $2 AND status = $4 RETURNING host_id',
    [inviteId, guestId, accept ? 'accepted' : 'declined', 'pending']);
  if (!r) throw E.notFound('Invite not found');
  toUsers([guestId, r.host_id], 'invites:update', {});
}

/** Once per day per visitor; the owner's companion gets a little energy. */
export async function cheerRoom(visitorId: string, ownerId: string) {
  if (visitorId === ownerId) throw E.badRequest("You can't cheer your own room");
  // Blocked either way: behave as if the room doesn't exist (like visiting it).
  if (await isBlocked(visitorId, ownerId)) throw E.notFound('Room not found');
  const tz = (await one<{ timezone: string }>('SELECT timezone FROM users WHERE id = $1', [ownerId]))?.timezone;
  if (!tz) throw E.notFound('Room not found');
  const day = localDay(tz);
  const fresh = await tx(async (c) => {
    const r = await c.query('INSERT INTO room_cheers (owner_id, user_id, day) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [ownerId, visitorId, day]);
    return (r.rowCount ?? 0) > 0;
  });
  if (!fresh) throw E.conflict('You already cheered this room today');
  await enqueue.quests(`roomvisit:${ownerId}:${visitorId}:${day}`, { kind: 'room.visit', ownerId, visitorId });
}

/** Your pending invites from the last week, newest first (none from people blocked either way). */
export async function listInvites(userId: string): Promise<RoomInvite[]> {
  const rows = await q<{ id: string; host_id: string; created_at: Date; display_name: string; avatar_color: string; avatar_url: string | null }>(
    `SELECT i.id, i.host_id, i.created_at, u.display_name, u.avatar_color, u.avatar_url
       FROM room_invites i JOIN users u ON u.id = i.host_id
      WHERE i.guest_id = $1 AND i.status = 'pending' AND i.created_at > now() - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM friendships bl WHERE bl.status = 'blocked'
                          AND ((bl.user_id = $1 AND bl.friend_id = i.host_id) OR (bl.user_id = i.host_id AND bl.friend_id = $1)))
      ORDER BY i.created_at DESC LIMIT 20`, [userId],
  );
  return rows.map((r) => ({ id: r.id, hostId: r.host_id, hostName: r.display_name, hostInitials: initialsOf(r.display_name), hostColor: r.avatar_color, hostUrl: r.avatar_url, createdAt: r.created_at.toISOString() }));
}
