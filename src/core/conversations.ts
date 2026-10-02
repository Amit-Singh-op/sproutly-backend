import { one, q, tx, type Db } from '../db/pool.js';
import { rooms, toRoom, toUser, toUsers } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { isOnline, onlineMap } from '../lib/presence.js';
import { LIMITS, initialsOf, previewFor } from '../shared/rules.js';
import { liveCount, liveCounts } from './live.js';
import { friendStreakView, utcDay } from '../shared/retention.js';
import { ROOM_LIVE_CAPACITY, type ConversationDetail, type ConversationSummary, type EventCard, type GroupCard, type MemberReceipt, type Message } from '../shared/types.js';
import { isPlus, requirePlus } from './entitlements.js';
import { isBlocked } from './users.js';

export interface MemberRow {
  conversation_id: string; user_id: string; role: string; delivered_seq: number; read_seq: number;
  muted_until: Date | null; pinned: boolean; archived: boolean; read_only: boolean;
}

/** Doc section 12: membership is checked on every conversation read and write. */
export async function requireMember(userId: string, conversationId: string, db?: Db): Promise<MemberRow> {
  const m = await one<MemberRow>('SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, userId], db);
  if (!m) throw E.notFound('Conversation not found');
  return m;
}

export async function memberIds(conversationId: string, db?: Db): Promise<string[]> {
  return (await q<{ user_id: string }>('SELECT user_id FROM conversation_members WHERE conversation_id = $1', [conversationId], db)).map((r) => r.user_id);
}

interface SummaryRow {
  id: string; kind: 'dm' | 'group'; title: string | null; avatar_color: string; last_seq: number; last_message_at: Date | null;
  member_count: number; max_members: number; plus_only: boolean; muted_until: Date | null; pinned: boolean; unread: number;
  other_id: string | null; other_name: string | null; other_color: string | null; other_avatar_url: string | null;
  lm_type: Message['type'] | null; lm_body: string | null; lm_payload: Message['payload']; lm_deleted_at: Date | null; lm_sender: string | null; lm_at: Date | null; lm_sender_name: string | null;
  fs_count: number | null; fs_last_day: string | null; fs_a_day: string | null; fs_b_day: string | null;
}

const SUMMARY_SQL = `
  SELECT c.id, c.kind, c.title, c.avatar_color, c.last_seq, c.last_message_at, c.member_count, c.max_members, c.plus_only,
         m.muted_until, m.pinned,
         (SELECT count(*)::int FROM messages x WHERE x.conversation_id = c.id AND x.seq > m.read_seq AND x.created_at > now() - interval '3 days'
             AND x.sender_id IS DISTINCT FROM m.user_id AND x.deleted_at IS NULL AND x.type <> 'system') AS unread,
         o.id AS other_id, o.display_name AS other_name, o.avatar_color AS other_color, o.avatar_url AS other_avatar_url,
         lm.type AS lm_type, lm.body AS lm_body, lm.payload AS lm_payload, lm.deleted_at AS lm_deleted_at, lm.sender_id AS lm_sender, lm.created_at AS lm_at,
         su.display_name AS lm_sender_name,
         fs.count AS fs_count, fs.last_day AS fs_last_day, fs.a_day AS fs_a_day, fs.b_day AS fs_b_day
    FROM conversation_members m
    JOIN conversations c ON c.id = m.conversation_id
    LEFT JOIN LATERAL (
      SELECT u.id, u.display_name, u.avatar_color, u.avatar_url FROM conversation_members m2 JOIN users u ON u.id = m2.user_id
       WHERE c.kind = 'dm' AND m2.conversation_id = c.id AND m2.user_id <> m.user_id LIMIT 1
    ) o ON TRUE
    -- The newest message worth showing in the list: older chats can end in a "X joined" / "X left" note, which stays quiet.
    LEFT JOIN LATERAL (
      SELECT x.* FROM messages x
       WHERE x.conversation_id = c.id AND x.created_at > now() - interval '3 days'
         AND NOT (x.type = 'system' AND (x.payload->>'event' = 'member_left'
              OR (x.payload->>'event' = 'member_joined' AND x.payload->>'text' NOT LIKE '%created the group')))
       ORDER BY x.seq DESC LIMIT 1
    ) lm ON TRUE
    LEFT JOIN users su ON su.id = lm.sender_id
    LEFT JOIN friend_streaks fs ON c.kind = 'dm' AND o.id IS NOT NULL
         AND fs.user_a = LEAST(m.user_id, o.id) AND fs.user_b = GREATEST(m.user_id, o.id)
   WHERE m.user_id = $1`;

function toSummary(r: SummaryRow, viewerId: string): ConversationSummary {
  const title = r.kind === 'dm' ? r.other_name ?? 'Chat' : r.title ?? 'Group';
  return {
    id: r.id,
    kind: r.kind,
    title,
    avatarColor: r.kind === 'dm' ? r.other_color ?? r.avatar_color : r.avatar_color,
    avatarUrl: r.kind === 'dm' ? r.other_avatar_url : null,
    initials: initialsOf(title),
    lastSeq: r.last_seq,
    lastMessageAt: (r.lm_at ?? r.last_message_at)?.toISOString() ?? null,
    lastMessagePreview: r.lm_type
      ? previewFor({ type: r.lm_type, body: r.lm_body, payload: r.lm_payload, deletedAt: r.lm_deleted_at?.toISOString() ?? null },
        { isGroup: r.kind === 'group', senderName: r.lm_sender_name ?? '', mine: r.lm_sender === viewerId })
      : null,
    unread: r.unread,
    memberCount: r.member_count,
    ...(r.kind === 'group' ? { capacity: ROOM_LIVE_CAPACITY } : {}),
    plusOnly: r.plus_only,
    otherUserId: r.other_id,
    muted: !!r.muted_until && r.muted_until.getTime() > Date.now(),
    pinned: r.pinned,
    friendStreak: r.kind === 'dm' && r.other_id && r.fs_count !== null
      ? friendStreakView({ count: r.fs_count, lastDay: r.fs_last_day, aDay: r.fs_a_day, bDay: r.fs_b_day }, viewerId < r.other_id ? 'a' : 'b', utcDay())
      : null,
  };
}

const pendingCounts = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * A group's live numbers (members, and how many are in the chat right now out of ROOM_LIVE_CAPACITY) to everyone
 * looking at the group list, everyone in the chat and every member's chat list. Bursts of joins and leaves are
 * batched (one send per group every 300 ms).
 */
export function broadcastGroupCount(id: string): Promise<void> {
  if (!pendingCounts.has(id)) {
    pendingCounts.set(id, setTimeout(() => {
      pendingCounts.delete(id);
      sendGroupCount(id).catch(() => {});
    }, 300));
  }
  return Promise.resolve();
}
async function sendGroupCount(id: string) {
  const c = await one<{ member_count: number; is_public: boolean; kind: string }>(
    'SELECT member_count, is_public, kind FROM conversations WHERE id = $1', [id],
  );
  if (!c || c.kind !== 'group') return;
  const live = await liveCount(id);
  const payload = { id, memberCount: c.member_count, liveCount: live, capacity: ROOM_LIVE_CAPACITY, full: live >= ROOM_LIVE_CAPACITY };
  if (c.is_public) toRoom(rooms.discover, 'group:count', payload);
  toRoom(rooms.conv(id), 'group:count', payload);
  // Members see it in their chat list too (not only while the chat is open).
  toUsers(await memberIds(id), 'group:count', payload);
}

/** GET /conversations: pinned first, then by last message; archived hidden. */
export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const rows = await q<SummaryRow>(`${SUMMARY_SQL} AND NOT m.archived ORDER BY m.pinned DESC, c.last_message_at DESC NULLS LAST, c.created_at DESC`, [userId]);
  // Seed each DM's presence dot; live 'presence' events keep it current after this.
  const online = await onlineMap([...new Set(rows.map((r) => r.other_id).filter((x): x is string => !!x))]);
  const live = await liveCounts(rows.filter((r) => r.kind === 'group').map((r) => r.id));
  return rows.map((r) => ({
    ...toSummary(r, userId),
    otherOnline: r.other_id ? online[r.other_id] ?? false : false,
    ...(r.kind === 'group' ? { liveCount: live[r.id] ?? 0 } : {}),
  }));
}

export async function summaryFor(userId: string, conversationId: string, db?: Db): Promise<ConversationSummary | null> {
  const r = await one<SummaryRow>(`${SUMMARY_SQL} AND c.id = $2`, [userId, conversationId], db);
  return r ? toSummary(r, userId) : null;
}

export async function conversationDetail(userId: string, id: string): Promise<ConversationDetail> {
  const m = await requireMember(userId, id);
  const c = await one<{ id: string; kind: 'dm' | 'group'; title: string | null; avatar_color: string; member_count: number; plus_only: boolean }>(
    'SELECT id, kind, title, avatar_color, member_count, plus_only FROM conversations WHERE id = $1', [id],
  );
  if (!c) throw E.notFound('Conversation not found');
  const members = await q<{ user_id: string; display_name: string; avatar_color: string; avatar_url: string | null; last_seen_at: Date | null }>(
    `SELECT m.user_id, u.display_name, u.avatar_color, u.avatar_url, u.last_seen_at FROM conversation_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = $1 LIMIT ${LIMITS.plusGroupMax}`, [id],
  );
  const other = c.kind === 'dm' ? members.find((x) => x.user_id !== userId) : undefined;
  const online = await onlineMap(members.map((x) => x.user_id));
  const title = c.kind === 'dm' ? other?.display_name ?? 'Chat' : c.title ?? 'Group';
  const blocked = other ? await isBlocked(userId, other.user_id) : false;
  return {
    id: c.id,
    kind: c.kind,
    title,
    initials: initialsOf(title),
    avatarColor: c.kind === 'dm' ? other?.avatar_color ?? c.avatar_color : c.avatar_color,
    avatarUrl: c.kind === 'dm' && !blocked ? other?.avatar_url ?? null : null,
    memberCount: c.member_count,
    onlineCount: Object.values(online).filter(Boolean).length,
    otherUserId: other?.user_id ?? null,
    otherOnline: other && !blocked ? online[other.user_id] ?? false : false,
    otherLastSeenAt: other && !blocked ? other.last_seen_at?.toISOString() ?? null : null,
    plusOnly: c.plus_only,
    readOnly: m.read_only,
    myReadSeq: m.read_seq,
    members: members.map((x) => ({
      userId: x.user_id,
      displayName: x.display_name,
      avatarColor: x.avatar_color,
      avatarUrl: x.avatar_url,
      online: online[x.user_id] ?? false,
      lastSeenAt: x.last_seen_at?.toISOString() ?? null,
    })),
  };
}

/** Doc 6.4: read receipts off works both ways (their readSeq shows as 0; they see 0 for everyone). */
export async function receipts(userId: string, id: string): Promise<MemberReceipt[]> {
  await requireMember(userId, id);
  const viewer = await one<{ read_receipts: boolean }>('SELECT read_receipts FROM users WHERE id = $1', [userId]);
  const rows = await q<{ user_id: string; delivered_seq: number; read_seq: number; read_receipts: boolean }>(
    `SELECT m.user_id, m.delivered_seq, m.read_seq, u.read_receipts FROM conversation_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = $1 AND m.user_id <> $2`, [id, userId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    deliveredSeq: r.delivered_seq,
    readSeq: viewer?.read_receipts && r.read_receipts ? r.read_seq : 0,
  }));
}

/** POST /conversations {kind:'dm'}: idempotent per pair via dm_key. */
export async function openDm(userId: string, otherId: string): Promise<ConversationSummary> {
  if (userId === otherId) throw E.badRequest("You can't message yourself");
  if (!(await one('SELECT 1 FROM users WHERE id = $1', [otherId]))) throw E.notFound('User not found');
  if (await isBlocked(userId, otherId)) throw E.forbidden('You can’t message this person');
  const key = [userId, otherId].sort().join(':');
  const id = await tx(async (c) => {
    const existing = await one<{ id: string }>('SELECT id FROM conversations WHERE dm_key = $1', [key], c);
    if (existing) {
      await q('UPDATE conversation_members SET archived = FALSE WHERE conversation_id = $1 AND user_id = $2', [existing.id, userId], c);
      return existing.id;
    }
    const conv = await one<{ id: string }>(
      `INSERT INTO conversations (kind, dm_key, owner_id, member_count, max_members) VALUES ('dm', $1, $2, 2, 2)
       ON CONFLICT (dm_key) DO UPDATE SET dm_key = EXCLUDED.dm_key RETURNING id`, [key, userId], c,
    );
    await q(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1,$2), ($1,$3) ON CONFLICT DO NOTHING`,
      [conv!.id, userId, otherId], c,
    );
    return conv!.id;
  });
  return (await summaryFor(userId, id))!;
}

export async function createGroup(userId: string, g: { title: string; category: string; isPublic: boolean; avatarColor: string; memberIds: string[] }): Promise<ConversationSummary> {
  const plus = await isPlus(userId);
  const max = plus ? LIMITS.plusGroupMax : LIMITS.freeGroupMax;
  const ids = [...new Set(g.memberIds.filter((x) => x !== userId))];
  if (ids.length + 1 > max) throw plus ? E.badRequest(`Groups can have up to ${max} members`) : E.plusRequired('group_size');
  const id = await tx(async (c) => {
    const conv = await one<{ id: string }>(
      `INSERT INTO conversations (kind, title, avatar_color, category, is_public, owner_id, max_members, member_count)
       VALUES ('group', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [g.title.trim().slice(0, 60), g.avatarColor, g.category, g.isPublic, userId, max, ids.length + 1], c,
    );
    await q(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'owner')`, [conv!.id, userId], c);
    if (ids.length) {
      // Only existing users who haven't blocked the creator.
      await q(
        `INSERT INTO conversation_members (conversation_id, user_id)
         SELECT $1, u.id FROM users u WHERE u.id = ANY($2::uuid[])
            AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = u.id AND f.friend_id = $3 AND f.status = 'blocked')
         ON CONFLICT DO NOTHING`, [conv!.id, ids, userId], c,
      );
      await q('UPDATE conversations SET member_count = (SELECT count(*) FROM conversation_members WHERE conversation_id = $1) WHERE id = $1', [conv!.id], c);
    }
    return conv!.id;
  });
  const { sendSystem } = await import('./messages.js');
  const creator = await one<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [userId]);
  await sendSystem(id, 'member_joined', `${creator?.display_name ?? 'Someone'} created the group`);
  return (await summaryFor(userId, id))!;
}

export async function discoverGroups(userId: string, category?: string): Promise<{ items: GroupCard[]; next: null }> {
  const rows = await q<{ id: string; title: string; description: string | null; category: string | null; member_count: number; max_members: number; avatar_color: string; plus_only: boolean; joined: boolean }>(
    `SELECT c.id, c.title, c.description, c.category, c.member_count, c.max_members, c.avatar_color, c.plus_only,
            EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = $1) AS joined
       FROM conversations c
      WHERE c.kind = 'group' AND c.is_public ${category ? 'AND c.category = $2' : ''}
      ORDER BY c.member_count DESC, c.created_at DESC LIMIT 50`,
    category ? [userId, category] : [userId],
  );
  const live = await liveCounts(rows.map((r) => r.id));
  return {
    items: rows.map((r) => ({
      id: r.id, title: r.title, description: r.description ?? '', category: r.category ?? 'For you', memberCount: r.member_count,
      avatarColor: r.avatar_color, initials: initialsOf(r.title), plusOnly: r.plus_only, joined: r.joined,
      liveCount: live[r.id] ?? 0, capacity: ROOM_LIVE_CAPACITY, full: (live[r.id] ?? 0) >= ROOM_LIVE_CAPACITY,
    })),
    next: null,
  };
}

export async function joinGroup(userId: string, id: string): Promise<ConversationSummary> {
  const c = await one<{ kind: string; is_public: boolean; plus_only: boolean; max_members: number; member_count: number }>(
    'SELECT kind, is_public, plus_only, max_members, member_count FROM conversations WHERE id = $1', [id],
  );
  if (!c || c.kind !== 'group' || !c.is_public) throw E.notFound('Group not found');
  if (c.plus_only) await requirePlus(userId, 'plus_group');
  const existing = await one('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [id, userId]);
  if (!existing) {
    // Membership has no limit (what's limited is how many are in the chat at once, see core/live.ts).
    await tx(async (t) => {
      const row = await one<{ last_seq: number }>('SELECT last_seq FROM conversations WHERE id = $1 FOR UPDATE', [id], t);
      // New members start "caught up": history is readable, but it doesn't count as unread.
      const ins = await t.query(`INSERT INTO conversation_members (conversation_id, user_id, read_seq, delivered_seq) VALUES ($1,$2,$3,$3) ON CONFLICT DO NOTHING`, [id, userId, row!.last_seq]);
      // Count only a real new member (a double tap racing itself inserts nothing).
      if ((ins.rowCount ?? 0) > 0) await t.query('UPDATE conversations SET member_count = member_count + 1 WHERE id = $1', [id]);
    });
    // No "X joined" message: who comes and goes stays quiet (the member count still updates live).
    await broadcastGroupCount(id);
  } else {
    await q('UPDATE conversation_members SET archived = FALSE WHERE conversation_id = $1 AND user_id = $2', [id, userId]);
  }
  const summary = (await summaryFor(userId, id))!;
  toUser(userId, 'conv:update', { id, lastSeq: summary.lastSeq, lastMessagePreview: summary.lastMessagePreview, lastMessageAt: summary.lastMessageAt, unread: summary.unread, summary });
  return summary;
}

export async function leaveGroup(userId: string, id: string) {
  const m = await requireMember(userId, id);
  const c = await one<{ kind: string }>('SELECT kind FROM conversations WHERE id = $1', [id]);
  if (c?.kind !== 'group') throw E.badRequest('You can only leave groups');
  await tx(async (t) => {
    await q('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [id, userId], t);
    await q('UPDATE conversations SET member_count = GREATEST(member_count - 1, 0) WHERE id = $1', [id], t);
  });
  void m;
  // Leaving is quiet too (no "X left" message).
  await broadcastGroupCount(id);
}

export async function patchMembership(userId: string, id: string, p: { mutedUntil?: string | null; pinned?: boolean; archived?: boolean }) {
  await requireMember(userId, id);
  const sets: string[] = [];
  const vals: unknown[] = [id, userId];
  if (p.mutedUntil !== undefined) { vals.push(p.mutedUntil); sets.push(`muted_until = $${vals.length}`); }
  if (p.pinned !== undefined) { vals.push(p.pinned); sets.push(`pinned = $${vals.length}`); }
  if (p.archived !== undefined) { vals.push(p.archived); sets.push(`archived = $${vals.length}`); }
  if (sets.length) await q(`UPDATE conversation_members SET ${sets.join(', ')} WHERE conversation_id = $1 AND user_id = $2`, vals);
}

export async function currentEvent(): Promise<EventCard | null> {
  const e = await one<{ id: string; title: string; description: string; reward_item_id: string | null; ends_at: Date; drop_multiplier: string; emoji: string | null }>(
    `SELECT id, title, description, reward_item_id, ends_at, drop_multiplier::text AS drop_multiplier, emoji
       FROM events WHERE now() BETWEEN starts_at AND ends_at ORDER BY starts_at DESC LIMIT 1`,
  );
  return e ? {
    id: e.id, title: e.title, description: e.description, rewardItemId: e.reward_item_id ?? '',
    endsAt: e.ends_at.toISOString(), dropMultiplier: Number(e.drop_multiplier) || 1, emoji: e.emoji,
  } : null;
}

export { isOnline };
