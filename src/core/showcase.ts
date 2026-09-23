import { one, q, tx } from '../db/pool.js';
import { E } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { limit } from '../lib/ratelimit.js';
import { LIMITS, RATE_LIMITS, cleanText, initialsOf, outfitName } from '../shared/rules.js';
import type { ShowcasePost } from '../shared/types.js';
import { isPlus } from './entitlements.js';

interface PostRow {
  id: string; user_id: string; caption: string; snapshot: ShowcasePost['snapshot']; cheer_count: number; created_at: Date;
  display_name: string; avatar_color: string; plus_active: boolean | null; cheered: boolean; top: boolean;
}

const POST_SELECT = `
  SELECT p.id, p.user_id, p.caption, p.snapshot, p.cheer_count, p.created_at, u.display_name, u.avatar_color, e.plus_active,
         EXISTS (SELECT 1 FROM showcase_cheers sc WHERE sc.post_id = p.id AND sc.user_id = $1) AS cheered,
         EXISTS (SELECT 1 FROM weekly_top w WHERE w.post_id = p.id AND w.week_start = date_trunc('week', now())::date) AS top
    FROM showcase_posts p JOIN users u ON u.id = p.user_id LEFT JOIN entitlements e ON e.user_id = p.user_id`;

const toPost = (r: PostRow): ShowcasePost => ({
  id: r.id, userId: r.user_id, authorName: r.display_name, authorInitials: initialsOf(r.display_name), authorColor: r.avatar_color,
  // Gold card + badge only; no ranking boost for Plus (doc section 11).
  authorIsPlus: !!r.plus_active, caption: r.caption, createdAt: r.created_at.toISOString(), snapshot: r.snapshot,
  cheerCount: r.cheer_count, cheeredByMe: r.cheered, topOfWeek: r.top,
});

async function nextPostAt(userId: string): Promise<string | null> {
  const last = await one<{ created_at: Date }>('SELECT created_at FROM showcase_posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId]);
  if (!last) return null;
  const next = last.created_at.getTime() + LIMITS.showcaseCooldownMs;
  return next > Date.now() ? new Date(next).toISOString() : null;
}

/** Feed: friends' (and my) posts from the last 72 h newest first, then public top posts by cheers. */
export async function feed(userId: string): Promise<{ items: ShowcasePost[]; next: null; nextPostAt: string | null }> {
  const friendsPosts = await q<PostRow>(
    `${POST_SELECT}
      WHERE NOT p.hidden AND p.created_at > now() - interval '72 hours'
        AND (p.user_id = $1
             OR EXISTS (SELECT 1 FROM showcase_feed f WHERE f.user_id = $1 AND f.post_id = p.id)
             OR EXISTS (SELECT 1 FROM friendships fr WHERE fr.user_id = $1 AND fr.friend_id = p.user_id AND fr.status = 'accepted'))
      ORDER BY p.created_at DESC LIMIT 50`, [userId],
  );
  const seen = new Set(friendsPosts.map((p) => p.id));
  const top = await q<PostRow>(
    `${POST_SELECT}
      WHERE NOT p.hidden AND p.created_at > now() - interval '72 hours'
        AND NOT EXISTS (SELECT 1 FROM friendships b WHERE b.status = 'blocked' AND ((b.user_id = $1 AND b.friend_id = p.user_id) OR (b.user_id = p.user_id AND b.friend_id = $1)))
      ORDER BY p.cheer_count DESC, p.created_at DESC LIMIT 50`, [userId],
  );
  const items = [...friendsPosts, ...top.filter((p) => !seen.has(p.id))].map(toPost);
  return { items, next: null, nextPostAt: await nextPostAt(userId) };
}

export async function getPost(userId: string, postId: string): Promise<ShowcasePost> {
  const r = await one<PostRow>(`${POST_SELECT} WHERE p.id = $2 AND NOT p.hidden`, [userId, postId]);
  if (!r) throw E.notFound('Post not found');
  return toPost(r);
}

/** One post per 24 h; the companion is snapshotted at post time. */
export async function createPost(userId: string, rawCaption: string): Promise<ShowcasePost> {
  const caption = cleanText(rawCaption).slice(0, 120);
  if (!caption) throw E.badRequest('Add a caption');
  const id = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`showcase:${userId}`]);
    const recent = await one(`SELECT 1 FROM showcase_posts WHERE user_id = $1 AND created_at > now() - interval '24 hours'`, [userId], c);
    if (recent) throw E.conflict('You can show off again tomorrow', { nextPostAt: await nextPostAt(userId) });
    const comp = await one<{ name: string; level: number; palette: string; equipped_outfit: string; signature_move: string }>(
      'SELECT name, level, palette, equipped_outfit, signature_move FROM companions WHERE user_id = $1', [userId], c,
    );
    const plus = await isPlus(userId);
    // Plus companions wear the glow aura on top of their outfit; the app draws the aura when the label mentions it.
    const outfit = comp!.equipped_outfit;
    const label = !plus || outfit === 'aura' ? outfitName(outfit) : outfit === 'none' ? 'Glow aura' : `${outfitName(outfit)} + Glow aura`;
    const snapshot = { name: comp!.name, level: comp!.level, palette: comp!.palette, outfit: comp!.equipped_outfit, outfitLabel: label, signatureMove: comp!.signature_move };
    const p = await one<{ id: string }>('INSERT INTO showcase_posts (user_id, caption, snapshot) VALUES ($1,$2,$3) RETURNING id', [userId, caption, JSON.stringify(snapshot)], c);
    return p!.id;
  });
  await enqueue.fanout({ postId: id });
  return getPost(userId, id);
}

/** Cheer toggle, idempotent through the (post_id, user_id) primary key. */
export async function cheer(userId: string, postId: string, on: boolean) {
  await limit(`cheer:${userId}`, RATE_LIMITS.cheersPerUser);
  const post = await one<{ user_id: string }>('SELECT user_id FROM showcase_posts WHERE id = $1 AND NOT hidden', [postId]);
  if (!post) throw E.notFound('Post not found');
  const changed = await tx(async (c) => {
    const r = on
      ? await c.query('INSERT INTO showcase_cheers (post_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [postId, userId])
      : await c.query('DELETE FROM showcase_cheers WHERE post_id = $1 AND user_id = $2', [postId, userId]);
    if (r.rowCount) await c.query('UPDATE showcase_posts SET cheer_count = (SELECT count(*) FROM showcase_cheers WHERE post_id = $1) WHERE id = $1', [postId]);
    return (r.rowCount ?? 0) > 0;
  });
  if (changed && on && post.user_id !== userId) await enqueue.push(`cheer:${postId}:${userId}`, { kind: 'cheer', postId, fromUserId: userId });
  const r = await one<{ cheer_count: number }>('SELECT cheer_count FROM showcase_posts WHERE id = $1', [postId]);
  return { cheerCount: r!.cheer_count, cheeredByMe: on };
}
