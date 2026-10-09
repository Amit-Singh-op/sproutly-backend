/**
 * Moderation: recording reports (with evidence), suspending accounts (automatically when several people report
 * someone, or by an admin) and lifting suspensions. A suspension takes effect immediately: sessions are revoked, the
 * app is told to sign out, and live connections are dropped. Everything is written to moderation_events, which
 * outlives the account, so it's easy to see what a person did.
 */
import { one, q } from '../db/pool.js';
import { kickUser, toUser } from '../lib/emitter.js';
import { log } from '../lib/log.js';
import { redis } from '../lib/redis.js';

/** Reports from this many different people within REPORT_WINDOW_DAYS suspend the account automatically. */
export const AUTO_SUSPEND_REPORTERS = 3;
export const REPORT_WINDOW_DAYS = 7;
const AUTO_REASON = 'Your account has been suspended because several people reported it. If you think this is a mistake, contact support.';

type TargetType = 'user' | 'message' | 'post' | 'story' | 'comment';

async function event(e: { userId: string | null; login?: string | null; kind: string; actor: string; reason?: string | null; details?: unknown }) {
  let login = e.login ?? null;
  if (!login && e.userId) login = (await one<{ login: string }>('SELECT login FROM users WHERE id = $1', [e.userId]))?.login ?? null;
  await q(
    `INSERT INTO moderation_events (subject_user_id, subject_login, kind, actor, reason, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [e.userId, login, e.kind, e.actor, e.reason ?? null, JSON.stringify(e.details ?? {})],
  );
}

/** Who owns the reported thing, and a copy of it as it was when reported (it may expire or be deleted later). */
async function snapshot(type: TargetType, id: string): Promise<{ ownerId: string | null; content: Record<string, unknown> }> {
  try {
    switch (type) {
      case 'user': {
        const u = await one<{ id: string; display_name: string; handle: string; avatar_url: string | null }>(
          'SELECT id, display_name, handle, avatar_url FROM users WHERE id = $1', [id]);
        return { ownerId: u?.id ?? null, content: u ? { displayName: u.display_name, handle: u.handle, avatarUrl: u.avatar_url } : {} };
      }
      case 'message': {
        const m = await one<{ sender_id: string | null; conversation_id: string; type: string; body: string | null; payload: unknown; created_at: Date }>(
          'SELECT sender_id, conversation_id, type, body, payload, created_at FROM messages WHERE id = $1', [id]);
        return { ownerId: m?.sender_id ?? null, content: m ? { conversationId: m.conversation_id, type: m.type, body: m.body, payload: m.payload, sentAt: m.created_at } : {} };
      }
      case 'post': {
        const p = await one<{ user_id: string; caption: string | null; image_url: string | null; created_at: Date }>(
          'SELECT user_id, caption, image_url, created_at FROM showcase_posts WHERE id = $1', [id]);
        return { ownerId: p?.user_id ?? null, content: p ? { caption: p.caption, imageUrl: p.image_url, postedAt: p.created_at } : {} };
      }
      case 'story': {
        const s = await one<Record<string, unknown> & { user_id: string }>('SELECT * FROM stories WHERE id = $1', [id]);
        if (!s) return { ownerId: null, content: {} };
        const { user_id, ...rest } = s;
        return { ownerId: user_id, content: rest };
      }
      case 'comment': {
        const c = await one<{ user_id: string; post_id: string; body: string; created_at: Date }>(
          'SELECT user_id, post_id, body, created_at FROM showcase_comments WHERE id = $1', [id]);
        return { ownerId: c?.user_id ?? null, content: c ? { postId: c.post_id, body: c.body, postedAt: c.created_at } : {} };
      }
    }
  } catch (err) {
    log.warn({ err, type, id }, 'moderation snapshot failed');
  }
  return { ownerId: null, content: {} };
}

/**
 * After a report is filed: keep a copy of what was reported against the person who posted it, then suspend them if
 * enough different people have reported them recently. Never throws (a report must not fail because of this).
 */
export async function recordReport(reporterId: string, type: TargetType, targetId: string, reason: string) {
  try {
    const { ownerId, content } = await snapshot(type, targetId);
    if (!ownerId || ownerId === reporterId) return;
    await event({ userId: ownerId, kind: 'report', actor: reporterId, reason, details: { targetType: type, targetId, content } });

    const r = await one<{ n: number }>(
      `SELECT count(DISTINCT actor)::int AS n FROM moderation_events
        WHERE subject_user_id = $1 AND kind = 'report' AND created_at > now() - make_interval(days => $2)`,
      [ownerId, REPORT_WINDOW_DAYS],
    );
    if ((r?.n ?? 0) >= AUTO_SUSPEND_REPORTERS) {
      const already = await one<{ s: Date | null }>('SELECT suspended_at AS s FROM users WHERE id = $1', [ownerId]);
      if (already && !already.s) {
        await suspendUser(ownerId, AUTO_REASON, 'system', { trigger: `${r!.n} people reported this account within ${REPORT_WINDOW_DAYS} days` });
      }
    }
  } catch (err) {
    log.error({ err, reporterId, type, targetId }, 'recording a report failed');
  }
}

/**
 * Suspends an account, effective immediately: no sign-in (or sign-up with the same email), sessions revoked, the app
 * told to sign out with the reason, live connections dropped.
 */
export async function suspendUser(userId: string, reason: string, actor: 'system' | 'admin', details: Record<string, unknown> = {}) {
  const u = await one<{ login: string }>(
    'UPDATE users SET suspended_at = now(), suspended_reason = $2 WHERE id = $1 RETURNING login', [userId, reason]);
  if (!u) throw new Error('No such user');
  await q(`INSERT INTO banned_logins (login, reason) VALUES ($1, $2) ON CONFLICT (login) DO UPDATE SET reason = EXCLUDED.reason`, [u.login, reason]);
  await q('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  await redis.del(`susp:${userId}`).catch(() => {});
  await event({ userId, login: u.login, kind: actor === 'system' ? 'auto_suspend' : 'suspend', actor, reason, details });
  // Tell the open app first (it shows the reason and signs out), then cut the live connection.
  toUser(userId, 'account:suspended', { message: reason });
  setTimeout(() => kickUser(userId), 500);
}

/** Lifts a suspension (by email), so the person can sign in again. */
export async function unsuspendLogin(login: string, note = '') {
  const u = await one<{ id: string }>('UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE login = $1 RETURNING id', [login]);
  await q('DELETE FROM banned_logins WHERE login = $1', [login]);
  if (u) await redis.del(`susp:${u.id}`).catch(() => {});
  await event({ userId: u?.id ?? null, login, kind: 'unsuspend', actor: 'admin', reason: note || null });
}

/** Is this email banned from signing in or up? (Covers a suspended person who deleted their account.) */
export async function bannedLogin(login: string): Promise<string | null> {
  const r = await one<{ reason: string | null }>('SELECT reason FROM banned_logins WHERE login = $1', [login]);
  return r ? (r.reason?.trim() || 'Your account has been suspended for breaking Sproutly’s community rules. If you think this is a mistake, contact support.') : null;
}

/** A suspended person tried to sign in: worth remembering (repeated attempts tell a story). */
export async function recordBlockedSignIn(login: string, userId: string | null) {
  await event({ userId, login, kind: 'sign_in_blocked', actor: 'system' }).catch(() => {});
}

/** Everything on record for an account, newest first (for the admin command). */
export async function history(login: string) {
  return q<{ kind: string; actor: string; reason: string | null; details: unknown; created_at: Date }>(
    `SELECT kind, actor, reason, details, created_at FROM moderation_events WHERE subject_login = $1 ORDER BY created_at DESC LIMIT 200`, [login]);
}
