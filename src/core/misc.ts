import { one, q } from '../db/pool.js';
import { E } from '../lib/errors.js';
import { LIMITS } from '../shared/rules.js';
import { isPlus } from './entitlements.js';

export async function registerDevice(userId: string, platform: 'ios' | 'android', pushToken: string, appVersion?: string) {
  // A push token belongs to one account at a time (shared phones / sign-out -> sign-in as someone else).
  await q('DELETE FROM devices WHERE push_token = $1 AND user_id <> $2', [pushToken, userId]);
  await q(
    `INSERT INTO devices (user_id, platform, push_token, app_version) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, push_token) DO UPDATE SET platform = EXCLUDED.platform, app_version = EXCLUDED.app_version, last_active_at = now()`,
    [userId, platform, pushToken, appVersion ?? null],
  );
}

/** Reports queue; a showcase post is auto-hidden after 5 distinct reports. */
export async function report(userId: string, targetType: 'user' | 'message' | 'post' | 'story' | 'comment', targetId: string, reason: string) {
  await q(
    `INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES ($1,$2,$3,$4)
     ON CONFLICT (reporter_id, target_type, target_id) DO NOTHING`, [userId, targetType, targetId, reason.slice(0, 500)],
  );
  if (targetType === 'post') {
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE target_type = 'post' AND target_id = $1`, [targetId]);
    if ((n?.n ?? 0) >= LIMITS.reportsToHide) await q('UPDATE showcase_posts SET hidden = TRUE WHERE id = $1', [targetId]);
  }
  if (targetType === 'comment') {
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE target_type = 'comment' AND target_id = $1`, [targetId]);
    if ((n?.n ?? 0) >= LIMITS.reportsToHide) {
      const r = await one<{ post_id: string }>('DELETE FROM showcase_comments WHERE id = $1 RETURNING post_id', [targetId]);
      if (r) await q('UPDATE showcase_posts SET comment_count = (SELECT count(*) FROM showcase_comments WHERE post_id = $1) WHERE id = $1', [r.post_id]);
    }
  }
  if (targetType === 'story') {
    const n = await one<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE target_type = 'story' AND target_id = $1`, [targetId]);
    if ((n?.n ?? 0) >= LIMITS.reportsToHide) await q('DELETE FROM stories WHERE id = $1', [targetId]);
  }
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
