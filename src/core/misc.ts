import { one, q } from '../db/pool.js';
import { E } from '../lib/errors.js';
import { LIMITS } from '../shared/rules.js';
import { isPlus } from './entitlements.js';
import { recordReport, reportedOwner } from './moderation.js';
import { limit } from '../lib/ratelimit.js';
import { REPORT_CATEGORY_INFO, type ReportCategory, type ReportTarget } from '../shared/types.js';

/** Reports one person can file a day. */
const REPORTS_PER_DAY = 20;

export async function registerDevice(userId: string, platform: 'ios' | 'android', pushToken: string, appVersion?: string, sessionId: string | null = null) {
  // A push token belongs to one account at a time (shared phones / sign-out -> sign-in as someone else).
  await q('DELETE FROM devices WHERE push_token = $1 AND user_id <> $2', [pushToken, userId]);
  await q(
    `INSERT INTO devices (user_id, platform, push_token, app_version, session_family) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, push_token) DO UPDATE SET platform = EXCLUDED.platform, app_version = EXCLUDED.app_version,
       session_family = COALESCE(EXCLUDED.session_family, devices.session_family), last_active_at = now()`,
    [userId, platform, pushToken, appVersion ?? null, sessionId],
  );
}

/**
 * File a report. You can only report what you can see (a message in a chat you're in; an account, post, story or
 * comment that exists), up to REPORTS_PER_DAY a day. Reporting the same thing again does nothing.
 * Posts, comments and stories that enough established accounts report are hidden (comments can be restored by a
 * moderator); what happens to the account is up to moderators (see moderation.ts: reports never ban anyone).
 */
export async function report(userId: string, targetType: ReportTarget, targetId: string, category: ReportCategory, note: string) {
  await limit(`reports:${userId}`, { points: REPORTS_PER_DAY, windowS: 86400 }, 'You’ve sent a lot of reports today.');
  if (targetType === 'message') {
    const ok = await one(`SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2 WHERE m.id = $1`, [targetId, userId]);
    if (!ok) throw E.notFound('Message not found');
  } else if (!(await reportedOwner(targetType, targetId))) {
    throw E.notFound('That’s no longer there');
  }
  const text = note.trim().slice(0, 500);
  const inserted = await one<{ id: string }>(
    `INSERT INTO reports (reporter_id, target_type, target_id, reason, category) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (reporter_id, target_type, target_id) DO NOTHING RETURNING id`, [userId, targetType, targetId, text || REPORT_CATEGORY_INFO[category].label, category],
  );
  if (!inserted) return;
  // Keep a copy of what was reported (before anything below can hide or delete it), and maybe put the owner on hold.
  await recordReport(inserted.id, userId, targetType, targetId, category, text);
  if (targetType === 'guestbook') {
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM reports r JOIN users u ON u.id = r.reporter_id WHERE r.target_type = 'guestbook' AND r.target_id = $1 AND r.status <> 'dismissed' AND u.created_at < now() - interval '2 days'`, [targetId]);
    if ((n?.n ?? 0) >= 2) await q('UPDATE guestbook_entries SET hidden = TRUE WHERE id = $1', [targetId]);
    return;
  }
  if (targetType !== 'post' && targetType !== 'comment' && targetType !== 'story') return;
  // Only reports from established accounts count towards hiding content (throwaway accounts can't gang up).
  const n = await one<{ n: number }>(
    `SELECT count(*)::int AS n FROM reports r JOIN users u ON u.id = r.reporter_id
      WHERE r.target_type = $1 AND r.target_id = $2 AND r.status <> 'dismissed' AND u.created_at < now() - interval '2 days'`, [targetType, targetId]);
  if ((n?.n ?? 0) < LIMITS.reportsToHide) return;
  if (targetType === 'post') await q('UPDATE showcase_posts SET hidden = TRUE WHERE id = $1', [targetId]);
  if (targetType === 'comment') {
    const r = await one<{ post_id: string }>('UPDATE showcase_comments SET hidden = TRUE WHERE id = $1 RETURNING post_id', [targetId]);
    if (r) await q('UPDATE showcase_posts SET comment_count = (SELECT count(*) FROM showcase_comments WHERE post_id = $1 AND NOT hidden) WHERE id = $1', [r.post_id]);
  }
  if (targetType === 'story') await q('DELETE FROM stories WHERE id = $1', [targetId]);
}

/** GET /catalog?kind=: items with plusOnly / owned / locked / isNew. */
export async function catalog(userId: string, kind: string) {
  if (!['outfit', 'move', 'decor', 'theme'].includes(kind)) throw E.badRequest('Unknown catalog kind');
  const plus = await isPlus(userId);
  const rows = await q<{ id: string; name: string; plus_only: boolean; owned: boolean; seen: boolean | null }>(
    `SELECT ci.id, ci.name, ci.plus_only, (ui.user_id IS NOT NULL) AS owned, ui.seen
       FROM catalog_items ci LEFT JOIN user_items ui ON ui.item_id = ci.id AND ui.user_id = $1
      WHERE ci.kind = $2 ORDER BY ci.sort`, [userId, kind],
  );
  return rows.map((r) => ({
    id: r.id.split(':')[1], name: r.name, plusOnly: r.plus_only,
    owned: r.owned || !r.plus_only || plus, locked: r.plus_only && !plus,
    isNew: r.plus_only && plus && !r.seen,
  }));
}

export async function markSeen(userId: string, ids: string[]) {
  await q(
    `INSERT INTO user_items (user_id, item_id, seen)
     SELECT $1, ci.id, TRUE FROM catalog_items ci WHERE split_part(ci.id, ':', 2) = ANY($2::text[]) OR ci.id = ANY($2::text[])
     ON CONFLICT (user_id, item_id) DO UPDATE SET seen = TRUE`, [userId, ids],
  );
}
