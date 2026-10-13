/**
 * Moderation tools for admins (ADMIN_EMAILS): the report queue, everything about one account, people search, the
 * actions (dismiss, warn, remove content, mute, suspend, ban, unban) and the log of what moderators did.
 * Every function checks the caller is an admin on the server; admins can't act on themselves or on other admins,
 * and every action needs a reason (it's written to moderation_events with the admin's id).
 */
import { z } from 'zod';
import { one, q } from '../db/pool.js';
import { toUsers } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { memberIds } from './conversations.js';
import { event, isAdmin, mute, suspendUser, unmute, unsuspendUser, warn } from './moderation.js';
import { toPeople } from './users.js';
import { REPORT_CATEGORIES, REPORT_CATEGORY_INFO, type ModEvent, type ModLogItem, type ModQueueItem, type ModReport, type ModStatus, type ModUserDetail, type ReportCategory, type ReportTarget } from '../shared/types.js';

export async function requireAdmin(userId: string) {
  if (!(await isAdmin(userId))) throw new AppError(403, 'FORBIDDEN', 'Only moderators can do that');
}

type UserRow = { id: string; display_name: string; handle: string; avatar_color: string; avatar_url: string | null; created_at: Date; suspended_at: Date | null; suspended_until: Date | null; muted_until: Date | null; warning: string | null };
const USER_COLS = 'id, display_name, handle, avatar_color, avatar_url, created_at, suspended_at, suspended_until, muted_until, warning';

async function statusOf(u: UserRow): Promise<ModStatus> {
  return {
    suspended: !!u.suspended_at && (!u.suspended_until || u.suspended_until.getTime() > Date.now()),
    suspendedUntil: u.suspended_until?.toISOString() ?? null,
    mutedUntil: u.muted_until && u.muted_until.getTime() > Date.now() ? u.muted_until.toISOString() : null,
    isAdmin: await isAdmin(u.id),
  };
}

const severityOf = (cats: string[]) => Math.max(1, ...cats.map((c) => REPORT_CATEGORY_INFO[c as ReportCategory]?.severity ?? 1)) as 1 | 2 | 3 | 4;

/** Open reports grouped by person: worst first (severity, then how many people, then newest). */
export async function queue(adminId: string): Promise<ModQueueItem[]> {
  await requireAdmin(adminId);
  const rows = await q<{ subject_id: string; open: number; reporters: number; last: Date; cats: string[] }>(
    `SELECT subject_id, count(*)::int AS open, count(DISTINCT reporter_id)::int AS reporters, max(created_at) AS last, array_agg(category) AS cats
       FROM reports WHERE status = 'open' AND subject_id IS NOT NULL GROUP BY subject_id ORDER BY max(created_at) DESC LIMIT 300`);
  if (rows.length === 0) return [];
  const users = await q<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = ANY($1::uuid[])`, [rows.map((r) => r.subject_id)]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const people = new Map((await toPeople(users)).map((p) => [p.id, p]));
  const out: ModQueueItem[] = [];
  for (const r of rows) {
    const u = byId.get(r.subject_id), p = people.get(r.subject_id);
    if (!u || !p) continue;
    const top = [...r.cats].sort((a, b) => (REPORT_CATEGORY_INFO[b as ReportCategory]?.severity ?? 1) - (REPORT_CATEGORY_INFO[a as ReportCategory]?.severity ?? 1))[0] as ReportCategory;
    out.push({ subject: p, status: await statusOf(u), openReports: r.open, reporters: r.reporters, severity: severityOf(r.cats), topCategory: top ?? 'other', lastReportedAt: r.last.toISOString() });
  }
  return out.sort((a, b) => b.severity - a.severity || b.reporters - a.reporters || b.lastReportedAt.localeCompare(a.lastReportedAt));
}

/** Everything about one account: status, reports against them (with the saved content), and their history. */
export async function userDetail(adminId: string, userId: string): Promise<ModUserDetail> {
  await requireAdmin(adminId);
  const u = await one<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [userId]);
  if (!u) throw E.notFound('No such account');
  const [[person], reports, events, filed, deleted] = await Promise.all([
    toPeople([u]),
    q<{ id: string; category: ReportCategory; reason: string; reporter_id: string | null; target_type: ReportTarget; target_id: string; status: ModReport['status']; created_at: Date;
        rname: string | null; rhandle: string | null; content: Record<string, unknown> | null; dismiss_rate: number | null; hidden: boolean | null }>(
      `SELECT r.id, r.category, r.reason, r.reporter_id, r.target_type, r.target_id, r.status, r.created_at,
              ru.display_name AS rname, ru.handle AS rhandle,
              (SELECT me.details->'content' FROM moderation_events me WHERE me.kind = 'report' AND me.details->>'reportId' = r.id::text LIMIT 1) AS content,
              (SELECT count(*) FILTER (WHERE d.status = 'dismissed')::float / greatest(count(*), 1) FROM reports d WHERE d.reporter_id = r.reporter_id AND d.status <> 'open') AS dismiss_rate,
              CASE r.target_type
                WHEN 'comment' THEN (SELECT hidden FROM showcase_comments WHERE id = r.target_id)
                WHEN 'post' THEN (SELECT hidden FROM showcase_posts WHERE id = r.target_id)
                WHEN 'message' THEN (SELECT deleted_at IS NOT NULL FROM messages WHERE id = r.target_id)
                WHEN 'guestbook' THEN (SELECT hidden FROM guestbook_entries WHERE id = r.target_id)
                ELSE NULL END AS hidden
         FROM reports r LEFT JOIN users ru ON ru.id = r.reporter_id
        WHERE r.subject_id = $1 ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 100`, [userId]),
    q<{ kind: string; actor: string; reason: string | null; details: Record<string, unknown>; created_at: Date; aname: string | null }>(
      `SELECT me.kind, me.actor, me.reason, me.details, me.created_at, au.display_name AS aname
         FROM moderation_events me LEFT JOIN users au ON au.id::text = me.actor
        WHERE me.subject_user_id = $1 AND me.kind <> 'report' ORDER BY me.created_at DESC LIMIT 100`, [userId]),
    one<{ n: number; dismissed: number }>(
      `SELECT count(*)::int AS n, (count(*) FILTER (WHERE status = 'dismissed'))::int AS dismissed FROM reports WHERE reporter_id = $1`, [userId]),
    q<{ message_id: string; conversation_id: string; type: string; body: string | null; sent_at: Date; deleted_at: Date }>(
      `SELECT message_id, conversation_id, type, body, sent_at, deleted_at FROM deleted_messages
        WHERE sender_id = $1 AND expires_at > now() ORDER BY deleted_at DESC LIMIT 50`, [userId]),
  ]);
  return {
    person: person!, joinedAt: u.created_at.toISOString(), status: await statusOf(u), warning: u.warning,
    reports: reports.map((r): ModReport => ({
      id: r.id, category: r.category, note: r.reason === REPORT_CATEGORY_INFO[r.category]?.label ? '' : r.reason,
      reporter: r.reporter_id && r.rname ? { id: r.reporter_id, displayName: r.rname, handle: r.rhandle ?? '' } : null,
      reporterDismissRate: r.dismiss_rate ?? 0, targetType: r.target_type, targetId: r.target_id, content: r.content ?? {},
      contentHidden: !!r.hidden, status: r.status, createdAt: r.created_at.toISOString(),
    })),
    history: events.map((e): ModEvent => ({ kind: e.kind, actor: e.actor, actorName: e.aname, reason: e.reason, details: e.details ?? {}, createdAt: e.created_at.toISOString() })),
    reportsFiled: filed?.n ?? 0, reportsFiledDismissed: filed?.dismissed ?? 0,
    deletedMessages: deleted.map((m) => ({ id: m.message_id, conversationId: m.conversation_id, type: m.type, body: m.body, sentAt: m.sent_at.toISOString(), deletedAt: m.deleted_at.toISOString() })),
  };
}

/** Find anyone by name or @handle (suspended accounts included). */
export async function searchPeople(adminId: string, term: string) {
  await requireAdmin(adminId);
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const users = await q<UserRow>(`SELECT ${USER_COLS} FROM users WHERE display_name ILIKE $1 OR handle ILIKE $1 ORDER BY display_name LIMIT 30`, [like]);
  const people = await toPeople(users);
  return Promise.all(users.map(async (u, i) => ({ person: people[i]!, status: await statusOf(u) })));
}

export const ActionBody = z.object({
  action: z.enum(['dismiss', 'warn', 'remove_content', 'mute', 'unmute', 'suspend', 'ban', 'unban']),
  reason: z.string().trim().min(3, 'Write a short reason').max(500),
  /** Mute length. */
  hours: z.number().int().min(1).max(24 * 30).optional(),
  /** Suspension length. */
  days: z.number().int().min(1).max(365).optional(),
  /** Which reports this is about (default: all open reports on the account). */
  reportIds: z.array(z.string().uuid()).max(100).optional(),
});
export type ActionBody = z.infer<typeof ActionBody>;

/** Hide or delete what an open report points at. */
async function removeTarget(type: ReportTarget, id: string) {
  if (type === 'message') {
    const m = await one<{ conversation_id: string; deleted_at: Date }>(
      `UPDATE messages SET deleted_at = now(), body = NULL, payload = NULL WHERE id = $1 AND deleted_at IS NULL RETURNING conversation_id, deleted_at`, [id]);
    if (m) toUsers(await memberIds(m.conversation_id), 'msg:update', { id, conversationId: m.conversation_id, body: null, deletedAt: m.deleted_at.toISOString() });
  } else if (type === 'post') {
    await q('UPDATE showcase_posts SET hidden = TRUE WHERE id = $1', [id]);
  } else if (type === 'comment') {
    const r = await one<{ post_id: string }>('UPDATE showcase_comments SET hidden = TRUE WHERE id = $1 RETURNING post_id', [id]);
    if (r) await q('UPDATE showcase_posts SET comment_count = (SELECT count(*) FROM showcase_comments WHERE post_id = $1 AND NOT hidden) WHERE id = $1', [r.post_id]);
  } else if (type === 'story') {
    await q('DELETE FROM stories WHERE id = $1', [id]);
  } else if (type === 'guestbook') {
    await q('UPDATE guestbook_entries SET hidden = TRUE WHERE id = $1', [id]);
  }
}

export async function act(adminId: string, userId: string, body: ActionBody): Promise<ModUserDetail> {
  await requireAdmin(adminId);
  if (userId === adminId) throw E.badRequest('You can’t moderate your own account');
  if (await isAdmin(userId)) throw E.badRequest('Moderators can’t act on other moderators');
  if (!(await one('SELECT 1 FROM users WHERE id = $1', [userId]))) throw E.notFound('No such account');
  const reportFilter = body.reportIds?.length ? 'AND id = ANY($2::uuid[])' : '';
  const args: unknown[] = body.reportIds?.length ? [userId, body.reportIds] : [userId];
  const closeReports = async (status: 'actioned' | 'dismissed') => q<{ id: string; target_type: ReportTarget; target_id: string }>(
    `UPDATE reports SET status = $${args.length + 1}, reviewed_by = $${args.length + 2}, reviewed_at = now()
      WHERE subject_id = $1 AND status = 'open' ${reportFilter} RETURNING id, target_type, target_id`, [...args, status, adminId]);

  switch (body.action) {
    case 'dismiss': {
      const closed = await closeReports('dismissed');
      await event({ userId, kind: 'dismiss', actor: adminId, reason: body.reason, details: { reports: closed.map((r) => r.id) } });
      // Nothing wrong after all: lift an automatic hold if that's what's on the account.
      const lastMute = await one<{ kind: string }>(`SELECT kind FROM moderation_events WHERE subject_user_id = $1 AND kind IN ('auto_hold', 'mute', 'unmute') ORDER BY created_at DESC LIMIT 1`, [userId]);
      if (lastMute?.kind === 'auto_hold') await unmute(userId, 'Reports dismissed', adminId);
      break;
    }
    case 'warn':
      await warn(userId, body.reason, adminId);
      await closeReports('actioned');
      break;
    case 'remove_content': {
      const open = await q<{ id: string; target_type: ReportTarget; target_id: string }>(
        `SELECT id, target_type, target_id FROM reports WHERE subject_id = $1 AND status = 'open' ${reportFilter}`, args);
      for (const r of open) if (r.target_type !== 'user') await removeTarget(r.target_type, r.target_id);
      await closeReports('actioned');
      await event({ userId, kind: 'remove_content', actor: adminId, reason: body.reason, details: { targets: open.map((r) => ({ type: r.target_type, id: r.target_id })) } });
      break;
    }
    case 'mute':
      await mute(userId, body.hours ?? 24, body.reason, adminId);
      await closeReports('actioned');
      break;
    case 'unmute':
      await unmute(userId, body.reason, adminId);
      break;
    case 'suspend':
      await suspendUser(userId, body.reason, adminId, {}, new Date(Date.now() + (body.days ?? 7) * 86400_000));
      await closeReports('actioned');
      break;
    case 'ban':
      await suspendUser(userId, body.reason, adminId, {}, null);
      await closeReports('actioned');
      break;
    case 'unban':
      await unsuspendUser(userId, body.reason, adminId);
      break;
  }
  return userDetail(adminId, userId);
}

/** What moderators (and the automatic hold) did recently, newest first. */
export async function modLog(adminId: string): Promise<ModLogItem[]> {
  await requireAdmin(adminId);
  const rows = await q<{ kind: string; actor: string; reason: string | null; details: Record<string, unknown>; created_at: Date; aname: string | null; subject_user_id: string | null; sname: string | null; shandle: string | null }>(
    `SELECT me.kind, me.actor, me.reason, me.details, me.created_at, au.display_name AS aname, me.subject_user_id, su.display_name AS sname, su.handle AS shandle
       FROM moderation_events me LEFT JOIN users au ON au.id::text = me.actor LEFT JOIN users su ON su.id = me.subject_user_id
      WHERE me.kind IN ('suspend', 'auto_suspend', 'unsuspend', 'auto_hold', 'warn', 'mute', 'unmute', 'remove_content', 'dismiss')
      ORDER BY me.created_at DESC LIMIT 200`);
  return rows.map((e) => ({
    kind: e.kind, actor: e.actor, actorName: e.aname, reason: e.reason, details: e.details ?? {}, createdAt: e.created_at.toISOString(),
    subject: e.subject_user_id ? { id: e.subject_user_id, displayName: e.sname ?? 'Deleted account', handle: e.shandle ?? '' } : null,
  }));
}

export { REPORT_CATEGORIES };
