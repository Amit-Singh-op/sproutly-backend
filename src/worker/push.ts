import { GoogleAuth } from 'google-auth-library';
import { config } from '../config.js';
import { one, q } from '../db/pool.js';
import { log } from '../lib/log.js';
import { isViewing } from '../lib/presence.js';
import type { PushJob } from '../lib/queues.js';
import { GUESTBOOK_EMOJI } from '../shared/types.js';
import { LIMITS, previewFor } from '../shared/rules.js';
import type { Message } from '../shared/types.js';

const auth = config.FCM_PROJECT_ID ? new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase.messaging'] }) : null;

interface Push { title: string; body: string; threadId?: string; data: Record<string, string> }

async function totalUnread(userId: string): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT COALESCE(sum((SELECT count(*) FROM messages x WHERE x.conversation_id = m.conversation_id AND x.seq > m.read_seq
                          AND x.sender_id IS DISTINCT FROM m.user_id AND x.deleted_at IS NULL AND x.type <> 'system')), 0)::int AS n
       FROM conversation_members m WHERE m.user_id = $1 AND NOT m.archived AND (m.muted_until IS NULL OR m.muted_until < now())`, [userId],
  );
  return r?.n ?? 0;
}

/** FCM HTTP v1 to every device of the user (Android + iOS via the APNs key in FCM). Dead tokens are removed. */
async function sendToUser(userId: string, p: Push) {
  const devices = await q<{ id: string; push_token: string; platform: string }>('SELECT id, push_token, platform FROM devices WHERE user_id = $1', [userId]);
  if (devices.length === 0) return;
  const badge = await totalUnread(userId);
  if (!auth) {
    log.info({ userId, ...p, badge }, 'push (FCM not configured, not sent)');
    return;
  }
  const token = await auth.getAccessToken();
  await Promise.all(devices.map(async (d) => {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${config.FCM_PROJECT_ID}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: d.push_token,
          notification: { title: p.title, body: p.body },
          data: p.data,
          android: { collapse_key: p.threadId, notification: { tag: p.threadId, channel_id: 'default', notification_count: badge } },
          apns: { payload: { aps: { 'thread-id': p.threadId, badge, sound: 'default' } } },
        },
      }),
    });
    if (res.ok) return;
    const text = await res.text();
    if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text)) {
      await q('DELETE FROM devices WHERE id = $1', [d.id]);
      return;
    }
    throw new Error(`FCM ${res.status}: ${text.slice(0, 200)}`);
  }));
}

export async function handlePush(job: PushJob) {
  if (job.kind === 'message') {
    const m = await one<{ id: string; conversation_id: string; sender_id: string | null; type: Message['type']; body: string | null; payload: Message['payload']; seq: number; kind: 'dm' | 'group'; title: string | null; sender_name: string | null }>(
      `SELECT x.id, x.conversation_id, x.sender_id, x.type, x.body, x.payload, x.seq, c.kind, c.title, u.display_name AS sender_name
         FROM messages x JOIN conversations c ON c.id = x.conversation_id LEFT JOIN users u ON u.id = x.sender_id
        WHERE x.id = $1 AND x.deleted_at IS NULL`, [job.messageId],
    );
    if (!m || !m.sender_id || m.type === 'system') return;
    const recipients = await q<{ user_id: string }>(
      `SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2 AND (muted_until IS NULL OR muted_until < now())`,
      [m.conversation_id, m.sender_id],
    );
    const sender = m.sender_name ?? 'Someone';
    const text = m.type === 'sticker' ? 'sent a sticker' : previewFor({ type: m.type, body: m.body, payload: m.payload, deletedAt: null }, { isGroup: false, senderName: sender, mine: false });
    for (const r of recipients) {
      // Anyone with the chat open on some device doesn't need a push.
      if (await isViewing(m.conversation_id, r.user_id)) continue;
      await sendToUser(r.user_id, {
        title: m.kind === 'dm' ? sender : m.title ?? 'Group',
        body: m.kind === 'dm' && m.type !== 'sticker' ? text : `${sender}: ${text}`,
        threadId: m.conversation_id,
        data: { type: 'message', conversationId: m.conversation_id, messageId: m.id },
      });
    }
    return;
  }
  if (job.kind === 'cheer') {
    const p = await one<{ user_id: string; from_name: string; companion: string }>(
      `SELECT p.user_id, u.display_name AS from_name, p.snapshot->>'name' AS companion FROM showcase_posts p, users u WHERE p.id = $1 AND u.id = $2`,
      [job.postId, job.fromUserId],
    );
    if (p) await sendToUser(p.user_id, { title: 'New cheer!', body: `${p.from_name} cheered for ${p.companion}`, data: { type: 'cheer', postId: job.postId } });
    return;
  }
  if (job.kind === 'invite') {
    const i = await one<{ guest_id: string; host_name: string; host_id: string }>(
      'SELECT i.guest_id, i.host_id, u.display_name AS host_name FROM room_invites i JOIN users u ON u.id = i.host_id WHERE i.id = $1', [job.inviteId],
    );
    if (i) await sendToUser(i.guest_id, { title: 'Room invite', body: `${i.host_name} invited you to their room`, data: { type: 'room', userId: i.host_id } });
    return;
  }
  if (job.kind === 'guestbook') {
    const g = await one<{ owner_id: string; author_name: string; companion: string; sticker: keyof typeof GUESTBOOK_EMOJI; note: string | null; earlier: number }>(
      `SELECT g.owner_id, a.display_name AS author_name, COALESCE(c.name, 'Mo') AS companion, g.sticker, g.note,
              (SELECT count(*)::int FROM guestbook_entries x WHERE x.owner_id = g.owner_id AND x.id <> g.id AND x.created_at <= g.created_at
                 AND (x.created_at AT TIME ZONE o.timezone)::date = (g.created_at AT TIME ZONE o.timezone)::date) AS earlier
         FROM guestbook_entries g JOIN users a ON a.id = g.author_id JOIN users o ON o.id = g.owner_id LEFT JOIN companions c ON c.user_id = g.owner_id
        WHERE g.id = $1 AND NOT g.hidden`, [job.entryId],
    );
    // Cap: the first few visits of the owner's day push; the rest only show in-app.
    if (!g || g.earlier >= LIMITS.guestbookPushesPerDay) return;
    await sendToUser(g.owner_id, {
      title: `${g.author_name} visited ${g.companion}'s room`,
      body: g.note ?? `left a ${GUESTBOOK_EMOJI[g.sticker]}`,
      threadId: 'guestbook',
      data: { type: 'guestbook', screen: 'room' },
    });
    return;
  }
  if (job.kind === 'level') {
    const c = await one<{ name: string }>('SELECT name FROM companions WHERE user_id = $1', [job.userId]);
    await sendToUser(job.userId, { title: 'Level up!', body: `${c?.name ?? 'Mo'} reached level ${job.level}`, data: { type: 'level' } });
  }
}
