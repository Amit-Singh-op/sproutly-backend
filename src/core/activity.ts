import { one, q } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { log } from '../lib/log.js';
import { activityText } from '../shared/retention.js';
import { initialsOf } from '../shared/rules.js';
import type { ActivityItem, ActivityKind, PaletteId } from '../shared/types.js';

/** Friend feed rows older than this are dropped by the cleanup job; the list shows at most LIST_MAX. */
export const ACTIVITY_KEEP_DAYS = 30;
const LIST_MAX = 50;
/** Fan-out to friends stops here (bigger audiences just don't get the row). */
const FANOUT_MAX = 500;

interface Row {
  id: string; kind: ActivityKind; data: Record<string, number | string>; seen: boolean; created_at: Date;
  actor_id: string | null; display_name: string | null; avatar_color: string | null; palette: PaletteId | null;
}
const SELECT = `SELECT a.id, a.kind, a.data, a.seen, a.created_at, a.actor_id, u.display_name, u.avatar_color, c.palette
                  FROM activity a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN companions c ON c.user_id = a.actor_id`;

const toItem = (r: Row): ActivityItem => {
  const name = r.display_name ?? 'Someone';
  return {
    id: r.id, kind: r.kind, data: r.data ?? {}, seen: r.seen, createdAt: r.created_at.toISOString(),
    actor: r.actor_id ? { id: r.actor_id, displayName: name, initials: initialsOf(name), avatarColor: r.avatar_color ?? '#2B2340', palette: r.palette ?? 'mo' } : null,
    text: activityText(r.kind, name, r.data ?? {}),
  };
};

/** Newest first. Rows from people either side has blocked are left out. */
export async function listActivity(userId: string): Promise<{ items: ActivityItem[]; unseen: number }> {
  const rows = await q<Row>(
    `${SELECT} WHERE a.user_id = $1 AND a.created_at > now() - make_interval(days => $2)
       AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'blocked'
                        AND ((f.user_id = $1 AND f.friend_id = a.actor_id) OR (f.user_id = a.actor_id AND f.friend_id = $1)))
     ORDER BY a.created_at DESC LIMIT ${LIST_MAX}`,
    [userId, ACTIVITY_KEEP_DAYS],
  );
  const items = rows.map(toItem);
  return { items, unseen: items.filter((i) => !i.seen).length };
}

export async function markActivitySeen(userId: string, ids?: string[]) {
  if (ids && ids.length) await q('UPDATE activity SET seen = TRUE WHERE user_id = $1 AND id = ANY($2::uuid[]) AND NOT seen', [userId, ids]);
  else await q('UPDATE activity SET seen = TRUE WHERE user_id = $1 AND NOT seen', [userId]);
}

/**
 * Add a row to each recipient's feed and tell their open apps. Best effort: a failure here is logged and never
 * breaks the action that caused it, so call it after the action's transaction has committed.
 */
export async function notifyActivity(userIds: string[], actorId: string | null, kind: ActivityKind, data: Record<string, number | string> = {}, ref?: string) {
  const targets = [...new Set(userIds)].filter((id) => id && id !== actorId);
  if (targets.length === 0) return;
  try {
    const inserted = await q<{ id: string; user_id: string }>(
      `INSERT INTO activity (user_id, actor_id, kind, data, ref)
       SELECT t, $2, $3, $4::jsonb, $5 FROM unnest($1::uuid[]) AS t
        WHERE NOT EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'blocked'
                           AND ((f.user_id = t AND f.friend_id = $2) OR (f.user_id = $2 AND f.friend_id = t)))
       ON CONFLICT (user_id, ref) WHERE ref IS NOT NULL DO NOTHING
       RETURNING id, user_id`,
      [targets, actorId, kind, JSON.stringify(data), ref ?? null],
    );
    if (inserted.length === 0) return;
    const sample = await one<Row>(`${SELECT} WHERE a.id = $1`, [inserted[0]!.id]);
    if (!sample) return;
    const base = toItem(sample);
    for (const r of inserted) toUser(r.user_id, 'activity:new', { ...base, id: r.id });
  } catch (err) {
    log.warn({ err: (err as Error).message, kind }, 'activity insert failed');
  }
}

/** Same, for everyone who has the actor as an accepted friend. */
export async function notifyFriends(actorId: string, kind: ActivityKind, data: Record<string, number | string> = {}, ref?: string) {
  try {
    const friends = await q<{ user_id: string }>(
      `SELECT user_id FROM friendships WHERE friend_id = $1 AND status = 'accepted' LIMIT ${FANOUT_MAX}`, [actorId],
    );
    await notifyActivity(friends.map((f) => f.user_id), actorId, kind, data, ref);
  } catch (err) {
    log.warn({ err: (err as Error).message, kind }, 'activity fan-out failed');
  }
}
