import { GoogleAuth } from 'google-auth-library';
import { config } from '../config.js';
import { one, q } from '../db/pool.js';
import { log } from '../lib/log.js';
import { isViewing } from '../lib/presence.js';
import type { PushJob } from '../lib/queues.js';
import { previewFor } from '../shared/rules.js';
import { notifyFriends } from '../core/activity.js';
import { payLevelCoins } from '../core/engagement.js';
import { levelCoins } from '../shared/retention.js';
import type { Message } from '../shared/types.js';

const auth = config.FCM_PROJECT_ID
  ? new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    ...(config.FCM_SERVICE_ACCOUNT_JSON ? { credentials: JSON.parse(config.FCM_SERVICE_ACCOUNT_JSON) } : {}),
  })
  : null;

/** Android notification channels the app creates (sproutly src/lib/push.ts). Unknown ids arrive silently. */
const CHANNEL = { messages: 'messages', general: 'general' } as const;

interface Push { title: string; body: string; threadId?: string; channel?: keyof typeof CHANNEL; data: Record<string, string> }

async function totalUnread(userId: string): Promise<number> {
  const r = await one<{ n: number }>(
    `SELECT COALESCE(sum((SELECT count(*) FROM messages x WHERE x.conversation_id = m.conversation_id AND x.seq > m.read_seq
                          AND x.sender_id IS DISTINCT FROM m.user_id AND x.deleted_at IS NULL AND x.type <> 'system' AND x.created_at > now() - interval '3 days')), 0)::int AS n
       FROM conversation_members m WHERE m.user_id = $1 AND NOT m.archived AND (m.muted_until IS NULL OR m.muted_until < now())`, [userId],
  );
  return r?.n ?? 0;
}

/** FCM HTTP v1 to every device of the user (Android + iOS via the APNs key in FCM). Dead tokens are removed. */
async function sendToUser(userId: string, p: Push) {
  // Settings → Notifications off: nothing reaches any of this user's devices.
  const pref = await one<{ on: boolean }>('SELECT notifications_enabled AS on FROM users WHERE id = $1', [userId]);
  if (!pref?.on) return;
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
          android: { collapse_key: p.threadId, notification: { tag: p.threadId, channel_id: CHANNEL[p.channel ?? 'general'], sound: 'default', notification_count: badge } },
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
    // Private chats notify every message; in groups only the people @mentioned get one.
    const all = await q<{ user_id: string; handle: string; display_name: string }>(
      `SELECT m.user_id, u.handle, u.display_name FROM conversation_members m JOIN users u ON u.id = m.user_id
        WHERE m.conversation_id = $1 AND m.user_id <> $2 AND (m.muted_until IS NULL OR m.muted_until < now())`,
      [m.conversation_id, m.sender_id],
    );
    const recipients = m.kind === 'dm' ? all : all.filter((r) => mentions(m.body, r.handle, r.display_name));
    if (recipients.length === 0) return;
    const sender = m.sender_name ?? 'Someone';
    // The phone's notification shade can't draw our Mo emojis, so codes like ":mo-laugh:" become the closest standard one.
    const text = m.type === 'sticker' ? 'sent a sticker' : emojiFallback(previewFor({ type: m.type, body: m.body, payload: m.payload, deletedAt: null }, { isGroup: false, senderName: sender, mine: false }));
    for (const r of recipients) {
      // Anyone with the chat open on some device doesn't need a push.
      if (await isViewing(m.conversation_id, r.user_id)) continue;
      await sendToUser(r.user_id, {
        title: m.kind === 'dm' ? sender : m.title ?? 'Group',
        body: m.kind === 'dm' && m.type !== 'sticker' ? text : `${sender} mentioned you: ${text}`,
        threadId: m.conversation_id,
        channel: 'messages',
        data: { type: 'message', conversationId: m.conversation_id, messageId: m.id },
      });
    }
    return;
  }
  // Cheers, room invites, guestbook visits and level-ups show in the app only; they never push.
  // A level-up does go to friends' activity feeds (the level job is the one place every level-up passes through).
  if (job.kind === 'level') {
    await payLevelCoins(job.userId, job.level, levelCoins(job.level));
    await notifyFriends(job.userId, 'level_up', { level: job.level }, `level:${job.userId}:${job.level}`);
    return;
  }
  if (job.kind === 'social') {
    await sendToUser(job.userId, { title: job.title, body: job.body, channel: 'general', data: job.data });
    return;
  }
  if (job.kind === 'cheer' || job.kind === 'invite' || job.kind === 'guestbook') return;
}

const EMOJI_FALLBACK: Record<string, string> = {
  smile: '🙂', laugh: '😂', love: '😍', wink: '😉', cool: '😎', wow: '😮', blush: '😊', sad: '😢', cry: '😭', angry: '😠', sleepy: '😴', party: '🥳',
  kiss: '😘', yum: '😋', think: '🤔', star: '🤩', smug: '😏', dizzy: '😵‍💫', bloom: '🌸', fire: '🔥', glitch: '⚡',
};
const emojiFallback = (s: string) => s.replace(/:(?:mo|pip|blu|drake|bolt)-(smile|laugh|love|wink|cool|wow|blush|sad|cry|angry|sleepy|party|kiss|yum|think|star|smug|dizzy|bloom|fire|glitch):/g, (_, f: string) => EMOJI_FALLBACK[f] ?? '');

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "@handle" or "@FirstName" (case-insensitive, whole word) anywhere in the message. */
export function mentions(body: string | null, handle: string, displayName: string): boolean {
  if (!body || !body.includes('@')) return false;
  const first = displayName.trim().split(/\s+/)[0] ?? '';
  const names = [handle, first].filter((n) => n.length >= 2).map(escape);
  if (names.length === 0) return false;
  return new RegExp(`(^|[^\\w@])@(${names.join('|')})(?![\\w])`, 'i').test(body);
}
