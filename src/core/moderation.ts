/**
 * Moderation: reports (with a copy of what was reported), and what moderators can do about them.
 *
 * Protecting people who did nothing wrong comes first:
 *   - reports never ban anyone by themselves. Enough reports from *trusted* reporters (accounts a few days old, not
 *     suspended, whose reports aren't usually dismissed) put the account on a 24-hour hold: it can read but not send
 *     anything until a moderator looks. Admins are told right away.
 *   - you can only report what you can see, and only so many times a day (see report() in misc.ts).
 * Moderators (ADMIN_EMAILS) then warn, remove content, mute, suspend for a while, ban, or dismiss. Everything is
 * written to moderation_events, which outlives the account, so it's easy to see what a person did and who acted.
 * A suspension takes effect immediately: sessions are revoked, the app signs out with the reason, connections drop.
 */
import { config } from '../config.js';
import { one, q } from '../db/pool.js';
import { kickUser, toUser } from '../lib/emitter.js';
import { AppError } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { log } from '../lib/log.js';
import { redis } from '../lib/redis.js';
import { flagText } from '../shared/safety.js';
import { REPORT_CATEGORY_INFO, type ReportCategory, type ReportTarget } from '../shared/types.js';

/** Reports count from REPORT_WINDOW_DAYS back. */
export const REPORT_WINDOW_DAYS = 7;
/** Trusted reporters (different people) that put an account on hold; fewer for the most serious reasons. */
const HOLD_REPORTERS = 3;
const HOLD_REPORTERS_CRITICAL = 2;
const HOLD_HOURS = 24;
/** Reporters need an account this old to count towards a hold. */
const TRUSTED_ACCOUNT_DAYS = 2;
const HOLD_REASON = 'Your account is on hold while we look at some reports. You can still read everything, but you can’t send messages or post for now.';
const DEFAULT_BAN_REASON = 'Your account has been suspended for breaking Sproutly’s community rules. If you think this is a mistake, contact support.';

type TargetType = ReportTarget;

// ---------------- admins ----------------

const adminLogins = new Set(config.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

/** Is this sign-in (email or phone) one of the moderators? */
export const isAdminLogin = (login: string) => adminLogins.has(login.trim().toLowerCase());

/** Is this account a moderator? (ADMIN_EMAILS on the server: the app can't make anyone one.) */
export async function isAdmin(userId: string): Promise<boolean> {
  if (adminLogins.size === 0) return false;
  const u = await one<{ login: string }>('SELECT login FROM users WHERE id = $1', [userId]);
  return !!u && adminLogins.has(u.login.toLowerCase());
}

async function adminIds(): Promise<string[]> {
  if (adminLogins.size === 0) return [];
  return (await q<{ id: string }>('SELECT id FROM users WHERE lower(login) = ANY($1::text[])', [[...adminLogins]])).map((r) => r.id);
}

/** A push to every moderator (best effort). */
function alertAdmins(title: string, body: string, ref: string) {
  void adminIds().then((ids) => {
    if (ids.length === 0) log.error({ title, body }, 'moderation alert with no moderators: set ADMIN_EMAILS');
    for (const id of ids) {
      enqueue.push(`${ref}:${id}`, { kind: 'social', userId: id, title, body, data: { type: 'moderation' } }).catch(() => {});
    }
  }).catch(() => {});
}

export async function event(e: { userId: string | null; login?: string | null; kind: string; actor: string; reason?: string | null; details?: unknown }) {
  let login = e.login ?? null;
  if (!login && e.userId) login = (await one<{ login: string }>('SELECT login FROM users WHERE id = $1', [e.userId]))?.login ?? null;
  // The network address and app install the account last used, kept with the moderation record only (see clientOf).
  const client = e.userId && e.kind !== 'sign_in_blocked' ? await clientOf(e.userId) : null;
  const details = { ...((e.details as Record<string, unknown>) ?? {}), ...(client ? { client } : {}) };
  await q(
    `INSERT INTO moderation_events (subject_user_id, subject_login, kind, actor, reason, details) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [e.userId, login, e.kind, e.actor, e.reason ?? null, JSON.stringify(details)],
  );
}

// ---------------- where an account was last used (for moderation records only) ----------------

const CLIENT_TTL_S = 30 * 86400;
const DEVICE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** A valid per-install id from the app's X-Device-Id header, or null. */
export const deviceIdOf = (raw: unknown) => (typeof raw === 'string' && DEVICE_ID.test(raw) ? raw : null);

/**
 * Remember the network address and app install an account last used (30 days, in Redis). Nothing reads this except
 * moderation: it's copied into a record when the account is reported or acted on. The install id is also listed in
 * user_devices (once a day per install) so a permanent ban can cover the device.
 */
export async function recordClient(userId: string, ip: string, deviceId: string | null) {
  await redis.set(`client:${userId}`, JSON.stringify({ ip, deviceId, at: new Date().toISOString() }), 'EX', CLIENT_TTL_S).catch(() => {});
  if (deviceId && (await redis.set(`devseen:${userId}:${deviceId}`, '1', 'EX', 86400, 'NX').catch(() => null)) === 'OK') {
    await q(`INSERT INTO user_devices (user_id, device_id) VALUES ($1, $2) ON CONFLICT (user_id, device_id) DO UPDATE SET last_seen = now()`, [userId, deviceId]).catch(() => {});
  }
}

export async function clientOf(userId: string): Promise<{ ip: string; deviceId: string | null; at: string } | null> {
  const raw = await redis.get(`client:${userId}`).catch(() => null);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** Is this app install banned (an account on it was banned for good)? */
export async function deviceBanned(deviceId: string | null): Promise<boolean> {
  if (!deviceId) return false;
  return !!(await one('SELECT 1 FROM banned_devices WHERE device_id = $1', [deviceId]));
}

/** Who owns the reported thing, and a copy of it as it was when reported (it may expire or be deleted later). */
async function snapshot(type: TargetType, id: string): Promise<{ ownerId: string | null; content: Record<string, unknown> }> {
  try {
    switch (type) {
      case 'user': {
        const u = await one<{ id: string; display_name: string; handle: string; avatar_url: string | null }>(
          'SELECT id, display_name, handle, avatar_url FROM users WHERE id = $1', [id]);
        // What they said in the Plaza lately (the Plaza keeps no other record), for reports made from there.
        const raw = u ? await redis.lrange(`plazalog:${u.id}`, 0, 9).catch(() => [] as string[]) : [];
        const plaza = raw.map((l) => { try { return JSON.parse(l) as unknown; } catch { return null; } }).filter(Boolean);
        return { ownerId: u?.id ?? null, content: u ? { displayName: u.display_name, handle: u.handle, avatarUrl: u.avatar_url, ...(plaza.length ? { plazaLines: plaza } : {}) } : {} };
      }
      case 'guestbook': {
        const g = await one<{ author_id: string; owner_id: string; sticker: string; note: string | null; created_at: Date }>(
          'SELECT author_id, owner_id, sticker, note, created_at FROM guestbook_entries WHERE id = $1', [id]);
        return { ownerId: g?.author_id ?? null, content: g ? { body: g.note, sticker: g.sticker, roomOwnerId: g.owner_id, postedAt: g.created_at } : {} };
      }
      case 'message': {
        const m = await one<{ sender_id: string | null; conversation_id: string; seq: number; type: string; body: string | null; payload: unknown; created_at: Date; deleted_at: Date | null }>(
          'SELECT sender_id, conversation_id, seq, type, body, payload, created_at, deleted_at FROM messages WHERE id = $1', [id]);
        if (!m) return { ownerId: null, content: {} };
        // Deleted before the report (or its sender deleted their account): the private copy still has it.
        const copy = m.deleted_at || !m.sender_id
          ? await one<{ sender_id: string | null; body: string | null; payload: unknown }>('SELECT sender_id, body, payload FROM deleted_messages WHERE message_id = $1', [id])
          : null;
        // The conversation around it (10 before, 10 after), so a moderator sees the whole exchange.
        const around = await q<{ seq: number; sender_id: string | null; handle: string | null; body: string | null; type: string; deleted_at: Date | null; copy: string | null; created_at: Date }>(
          `SELECT x.seq, COALESCE(x.sender_id, d.sender_id) AS sender_id, u.handle, x.body, x.type, x.deleted_at, d.body AS copy, x.created_at
             FROM messages x LEFT JOIN deleted_messages d ON d.message_id = x.id LEFT JOIN users u ON u.id = COALESCE(x.sender_id, d.sender_id)
            WHERE x.conversation_id = $1 AND x.seq BETWEEN $2 - 10 AND $2 + 10 ORDER BY x.seq`, [m.conversation_id, m.seq]);
        return {
          ownerId: m.sender_id ?? copy?.sender_id ?? null,
          content: {
            conversationId: m.conversation_id, type: m.type, body: m.body ?? copy?.body ?? null, payload: m.payload ?? copy?.payload ?? null,
            sentAt: m.created_at, ...(m.deleted_at ? { deletedAt: m.deleted_at } : {}),
            context: around.map((x) => ({ seq: x.seq, senderId: x.sender_id, handle: x.handle, text: x.body ?? x.copy ?? `(${x.type})`, deleted: !!x.deleted_at, at: x.created_at, reported: x.seq === m.seq })),
          },
        };
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

/** Who owns a reported thing (null when it's gone, or was never there). */
export async function reportedOwner(type: TargetType, id: string) {
  return (await snapshot(type, id)).ownerId;
}

/**
 * After a report is saved: keep a copy of what was reported against its owner, then decide whether to put the owner
 * on a short hold. Never throws (a report must not fail because of this). Reports never ban anyone.
 */
export async function recordReport(reportId: string, reporterId: string, type: TargetType, targetId: string, category: ReportCategory, note: string) {
  try {
    const { ownerId, content } = await snapshot(type, targetId);
    if (!ownerId || ownerId === reporterId) return;
    await q('UPDATE reports SET subject_id = $2 WHERE id = $1', [reportId, ownerId]);
    await event({ userId: ownerId, kind: 'report', actor: reporterId, reason: note || REPORT_CATEGORY_INFO[category].label, details: { reportId, category, targetType: type, targetId, content } });
    if (await isAdmin(ownerId)) return;

    if (REPORT_CATEGORY_INFO[category].severity >= 4) alertAdmins('Urgent report', `${REPORT_CATEGORY_INFO[category].label}: open the moderation queue`, `modalert:${reportId}`);

    // Different trusted people reporting this account recently: accounts a few days old, not suspended, and whose
    // reports aren't usually dismissed. Self-harm reports never count towards a hold (that person needs care).
    const r = await one<{ n: number; critical: number }>(
      `SELECT count(DISTINCT rp.reporter_id)::int AS n,
              (count(DISTINCT rp.reporter_id) FILTER (WHERE rp.category IN ('child_safety', 'violence')))::int AS critical
         FROM reports rp JOIN users ru ON ru.id = rp.reporter_id
        WHERE rp.subject_id = $1 AND rp.status <> 'dismissed' AND rp.category <> 'self_harm'
          AND rp.created_at > now() - make_interval(days => $2)
          AND ru.suspended_at IS NULL AND ru.created_at < now() - make_interval(days => $3)
          AND (SELECT count(*) FILTER (WHERE d.status = 'dismissed')::float / greatest(count(*), 1)
                 FROM reports d WHERE d.reporter_id = rp.reporter_id AND d.status <> 'open') < 0.6`,
      [ownerId, REPORT_WINDOW_DAYS, TRUSTED_ACCOUNT_DAYS],
    );
    const n = r?.n ?? 0, critical = r?.critical ?? 0;
    if (n >= HOLD_REPORTERS || critical >= HOLD_REPORTERS_CRITICAL) {
      const held = await one<{ id: string }>(
        `UPDATE users SET muted_until = now() + make_interval(hours => $2)
          WHERE id = $1 AND suspended_at IS NULL AND (muted_until IS NULL OR muted_until < now() + make_interval(hours => $2))
          RETURNING id`, [ownerId, HOLD_HOURS]);
      if (held) {
        await redis.del(`mute:${ownerId}`).catch(() => {});
        await event({ userId: ownerId, kind: 'auto_hold', actor: 'system', reason: HOLD_REASON, details: { trustedReporters: n, critical, hours: HOLD_HOURS } });
        toUser(ownerId, 'me:notice', { kind: 'muted', message: HOLD_REASON, until: new Date(Date.now() + HOLD_HOURS * 3600_000).toISOString() });
        alertAdmins('Account on hold', `${n} people reported someone. They're on a ${HOLD_HOURS}h hold until you review.`, `modhold:${ownerId}:${new Date().toISOString().slice(0, 13)}`);
      }
    }
  } catch (err) {
    log.error({ err, reporterId, type, targetId }, 'recording a report failed');
  }
}

// ---------------- mutes (can read, can't send) ----------------

const MUTE_CACHE_S = 20;

/** Until when this account can't send anything (null = it can). */
export async function mutedUntil(userId: string): Promise<Date | null> {
  const cached = await redis.get(`mute:${userId}`).catch(() => null);
  if (cached !== null) return cached && Date.parse(cached) > Date.now() ? new Date(cached) : null;
  const u = await one<{ muted_until: Date | null }>('SELECT muted_until FROM users WHERE id = $1', [userId]);
  const until = u?.muted_until && u.muted_until.getTime() > Date.now() ? u.muted_until : null;
  await redis.set(`mute:${userId}`, until ? until.toISOString() : '', 'EX', MUTE_CACHE_S).catch(() => {});
  return until;
}

/** A friendly 403 while muted (sending messages, posting, commenting, stories, Plaza lines, guestbook, bio, songs). */
export async function requireNotMuted(userId: string) {
  const until = await mutedUntil(userId);
  if (!until) return;
  const when = until.toISOString().slice(0, 16).replace('T', ' ');
  throw new AppError(403, 'MUTED', `You can’t send or post anything until ${when} UTC. You can still read everything.`, { until: until.toISOString() });
}

export async function mute(userId: string, hours: number, reason: string, actor: string) {
  const r = await one<{ muted_until: Date }>('UPDATE users SET muted_until = now() + make_interval(hours => $2) WHERE id = $1 RETURNING muted_until', [userId, hours]);
  await redis.del(`mute:${userId}`).catch(() => {});
  await event({ userId, kind: 'mute', actor, reason, details: { hours } });
  toUser(userId, 'me:notice', { kind: 'muted', message: reason, until: r?.muted_until.toISOString() ?? null });
}

export async function unmute(userId: string, reason: string, actor: string) {
  await q('UPDATE users SET muted_until = NULL WHERE id = $1', [userId]);
  await redis.del(`mute:${userId}`).catch(() => {});
  await event({ userId, kind: 'unmute', actor, reason });
}

// ---------------- warnings ----------------

/** A warning the person sees once, the next time the app opens (or right away when it's open). */
export async function warn(userId: string, message: string, actor: string) {
  await q('UPDATE users SET warning = $2 WHERE id = $1', [userId, message]);
  await event({ userId, kind: 'warn', actor, reason: message });
  toUser(userId, 'me:notice', { kind: 'warning', message, until: null });
}

export async function clearWarning(userId: string) {
  await q('UPDATE users SET warning = NULL WHERE id = $1', [userId]);
}

// ---------------- suspensions and bans ----------------

/**
 * Suspends an account, effective immediately: no sign-in (or sign-up with the same email) until `until` (null =
 * a permanent ban), sessions revoked, the app told to sign out with the reason, live connections dropped.
 */
export async function suspendUser(userId: string, reason: string, actor: string, details: Record<string, unknown> = {}, until: Date | null = null) {
  const why = reason.trim() || DEFAULT_BAN_REASON;
  const u = await one<{ login: string }>(
    'UPDATE users SET suspended_at = now(), suspended_reason = $2, suspended_until = $3 WHERE id = $1 RETURNING login', [userId, why, until]);
  if (!u) throw new Error('No such user');
  await q(`INSERT INTO banned_logins (login, reason, until) VALUES ($1, $2, $3) ON CONFLICT (login) DO UPDATE SET reason = EXCLUDED.reason, until = EXCLUDED.until`, [u.login, why, until]);
  await q('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  await redis.del(`susp:${userId}`).catch(() => {});
  // A permanent ban also covers the app installs this account used, so a new email on the same phone won't work.
  if (!until) await q(`INSERT INTO banned_devices (device_id, user_id, reason) SELECT device_id, user_id, $2 FROM user_devices WHERE user_id = $1 ON CONFLICT (device_id) DO NOTHING`, [userId, why]);
  await event({ userId, login: u.login, kind: actor === 'system' ? 'auto_suspend' : 'suspend', actor, reason: why, details: { ...details, until: until?.toISOString() ?? null } });
  // Tell the open app first (it shows the reason and signs out), then cut the live connection.
  toUser(userId, 'account:suspended', { message: why });
  setTimeout(() => kickUser(userId), 500);
}

/** Lifts a suspension by account id. */
export async function unsuspendUser(userId: string, note: string, actor: string) {
  const u = await one<{ login: string }>('UPDATE users SET suspended_at = NULL, suspended_reason = NULL, suspended_until = NULL WHERE id = $1 RETURNING login', [userId]);
  if (u) await q('DELETE FROM banned_logins WHERE login = $1', [u.login]);
  await q('DELETE FROM banned_devices WHERE user_id = $1', [userId]);
  await redis.del(`susp:${userId}`).catch(() => {});
  await event({ userId, login: u?.login ?? null, kind: 'unsuspend', actor, reason: note || null });
}

/** Lifts a suspension (by email), so the person can sign in again. */
export async function unsuspendLogin(login: string, note = '') {
  const u = await one<{ id: string }>('UPDATE users SET suspended_at = NULL, suspended_reason = NULL, suspended_until = NULL WHERE login = $1 RETURNING id', [login]);
  await q('DELETE FROM banned_logins WHERE login = $1', [login]);
  if (u) await q('DELETE FROM banned_devices WHERE user_id = $1', [u.id]);
  if (u) await redis.del(`susp:${u.id}`).catch(() => {});
  await event({ userId: u?.id ?? null, login, kind: 'unsuspend', actor: 'admin', reason: note || null });
}

/** Is this email banned from signing in or up right now? (Covers a suspended person who deleted their account.) */
export async function bannedLogin(login: string): Promise<string | null> {
  const r = await one<{ reason: string | null }>('SELECT reason FROM banned_logins WHERE login = $1 AND (until IS NULL OR until > now())', [login]);
  return r ? (r.reason?.trim() || DEFAULT_BAN_REASON) : null;
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

// ---------------- automatic flags (never block anything) ----------------

/**
 * Text that matched the short flag list (shared/safety.ts) becomes a report from "Automatic" in the moderation queue,
 * with a copy of the text. Nothing happens to the writer: no hold, no hiding, nothing they can see. Fire-and-forget.
 */
export function autoFlag(userId: string, targetType: TargetType, targetId: string, text: string | null | undefined) {
  const category = flagText(text);
  if (!category) return;
  void (async () => {
    if (await isAdmin(userId)) return;
    const r = await one<{ id: string }>(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason, category, subject_id) VALUES (NULL, $1, $2, $3, $4, $5) RETURNING id`,
      [targetType, targetId, 'Flagged automatically', category, userId]);
    await event({ userId, kind: 'auto_flag', actor: 'system', reason: REPORT_CATEGORY_INFO[category].label, details: { reportId: r?.id, category, targetType, targetId, content: { body: text } } });
    if (REPORT_CATEGORY_INFO[category].severity >= 4) alertAdmins('Flagged message', `${REPORT_CATEGORY_INFO[category].label}: open the moderation queue`, `modflag:${r?.id}`);
  })().catch((err) => log.warn({ err, userId }, 'auto flag failed'));
}

// ---------------- making sure serious reports are seen and answered ----------------

/** Reporters hear back when a moderator acts on their report (they're never told what, or who it was about). */
export async function thankReporters(reportIds: string[]) {
  if (reportIds.length === 0) return;
  const rows = await q<{ reporter_id: string }>(
    'SELECT DISTINCT reporter_id FROM reports WHERE id = ANY($1::uuid[]) AND reporter_id IS NOT NULL', [reportIds]);
  for (const r of rows) {
    enqueue.push(`modthanks:${r.reporter_id}:${reportIds[0]}`, {
      kind: 'social', userId: r.reporter_id, title: 'Thanks for your report',
      body: 'We looked into it and took action. Thanks for helping keep Sproutly safe.', data: { type: 'moderation' },
    }).catch(() => {});
  }
}

/** Worker (every 15 min): urgent reports still open after 30 minutes re-alert moderators, at most every 2 hours each. */
export async function remindUrgentReports() {
  const due = await q<{ id: string; category: ReportCategory }>(
    `UPDATE reports SET reminded_at = now()
      WHERE id IN (SELECT id FROM reports WHERE status = 'open' AND category IN ('child_safety', 'violence', 'self_harm')
                     AND created_at < now() - interval '30 minutes' AND (reminded_at IS NULL OR reminded_at < now() - interval '2 hours') LIMIT 50)
      RETURNING id, category`);
  if (due.length === 0) return;
  const label = REPORT_CATEGORY_INFO[due[0]!.category].label;
  alertAdmins('Urgent reports waiting', `${due.length} urgent ${due.length === 1 ? 'report' : 'reports'} (${label}${due.length > 1 ? ' and more' : ''}) still need review`,
    `modremind:${new Date().toISOString().slice(0, 13)}`);
}

