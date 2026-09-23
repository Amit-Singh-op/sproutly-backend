import { one, q, tx } from '../db/pool.js';
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
  const inv = await one<{ id: string }>(
    `INSERT INTO room_invites (host_id, guest_id) VALUES ($1,$2) RETURNING id`, [hostId, guestId],
  );
  await enqueue.push(`invite:${inv!.id}`, { kind: 'invite', inviteId: inv!.id });
  return { id: inv!.id };
}

export async function respond(guestId: string, inviteId: string, accept: boolean) {
  const r = await one('UPDATE room_invites SET status = $3 WHERE id = $1 AND guest_id = $2 AND status = $4 RETURNING id',
    [inviteId, guestId, accept ? 'accepted' : 'declined', 'pending']);
  if (!r) throw E.notFound('Invite not found');
}

/** Once per day per visitor; the owner's companion gets a little energy. */
export async function cheerRoom(visitorId: string, ownerId: string) {
  if (visitorId === ownerId) throw E.badRequest("You can't cheer your own room");
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

export async function listInvites(userId: string) {
  return q<{ id: string; host_id: string; status: string; created_at: Date }>(
    `SELECT id, host_id, status, created_at FROM room_invites WHERE guest_id = $1 AND status = 'pending' ORDER BY created_at DESC`, [userId],
  );
}
