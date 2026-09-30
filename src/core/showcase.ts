import { one, q, tx } from '../db/pool.js';
import { E } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { limit } from '../lib/ratelimit.js';
import { LIMITS, RATE_LIMITS, cleanText, initialsOf, outfitName } from '../shared/rules.js';
import { SHOWCASE_DAILY_MAX, type ShowcaseActivity, type ShowcasePost } from '../shared/types.js';
import { isPlus } from './entitlements.js';
import { isOwnCloudinaryUrl } from '../lib/cloudinary.js';
import { AUDIENCE } from './stories.js';

interface PostRow {
  id: string; user_id: string; caption: string; image_url: string | null; activity: ShowcaseActivity | null; snapshot: ShowcasePost['snapshot']; cheer_count: number; created_at: Date;
  display_name: string; avatar_color: string; avatar_url: string | null; plus_active: boolean | null; cheered: boolean; top: boolean;
}

const POST_SELECT = `
  SELECT p.id, p.user_id, p.caption, p.image_url, p.activity, p.snapshot, p.cheer_count, p.created_at, u.display_name, u.avatar_color, u.avatar_url, e.plus_active,
         EXISTS (SELECT 1 FROM showcase_cheers sc WHERE sc.post_id = p.id AND sc.user_id = $1) AS cheered,
         EXISTS (SELECT 1 FROM weekly_top w WHERE w.post_id = p.id AND w.week_start = date_trunc('week', now())::date) AS top
    FROM showcase_posts p JOIN users u ON u.id = p.user_id LEFT JOIN entitlements e ON e.user_id = p.user_id`;

const toPost = (r: PostRow): ShowcasePost => ({
  id: r.id, userId: r.user_id, authorName: r.display_name, authorInitials: initialsOf(r.display_name), authorColor: r.avatar_color, authorUrl: r.avatar_url,
  // Gold card + badge only; no ranking boost for Plus (doc section 11).
  authorIsPlus: !!r.plus_active, caption: r.caption, imageUrl: r.image_url, activity: r.activity, createdAt: r.created_at.toISOString(), snapshot: r.snapshot,
  cheerCount: r.cheer_count, cheeredByMe: r.cheered, topOfWeek: r.top,
});

/** Up to SHOWCASE_DAILY_MAX posts in any 24 h: null while you can post, else when the next slot opens. */
async function nextPostAt(userId: string): Promise<string | null> {
  const recent = await q<{ created_at: Date }>(
    `SELECT created_at FROM showcase_posts WHERE user_id = $1 AND created_at > now() - interval '24 hours' ORDER BY created_at ASC`, [userId],
  );
  if (recent.length < SHOWCASE_DAILY_MAX) return null;
  return new Date(recent[0]!.created_at.getTime() + 24 * 3600 * 1000).toISOString();
}

/** Feed: posts from the last 72 h by you, your friends and people you share a chat with, newest first. */
export async function feed(userId: string): Promise<{ items: ShowcasePost[]; next: null; nextPostAt: string | null }> {
  const rows = await q<PostRow>(
    `${POST_SELECT}
      WHERE NOT p.hidden AND p.created_at > now() - interval '72 hours' AND ${AUDIENCE('p.user_id')}
      ORDER BY p.created_at DESC LIMIT 100`, [userId],
  );
  return { items: rows.map(toPost), next: null, nextPostAt: await nextPostAt(userId) };
}

export async function getPost(userId: string, postId: string): Promise<ShowcasePost> {
  const r = await one<PostRow>(`${POST_SELECT} WHERE p.id = $2 AND NOT p.hidden AND ${AUDIENCE('p.user_id')}`, [userId, postId]);
  if (!r) throw E.notFound('Post not found');
  return toPost(r);
}

/** Up to SHOWCASE_DAILY_MAX posts per 24 h; the companion is snapshotted at post time. Photo optional; without one a caption is required. */
export async function createPost(userId: string, rawCaption: string, imageUrl?: string | null, activity?: ShowcaseActivity | null): Promise<ShowcasePost> {
  const caption = cleanText(rawCaption ?? '').slice(0, 120);
  if (imageUrl && !isOwnCloudinaryUrl(imageUrl, userId, 'showcase')) throw E.badRequest('Upload the photo first, then post it.');
  if (!caption && !imageUrl) throw E.badRequest('Add a photo or a caption');
  const id = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`showcase:${userId}`]);
    const recent = await one<{ n: number }>(`SELECT count(*)::int AS n FROM showcase_posts WHERE user_id = $1 AND created_at > now() - interval '24 hours'`, [userId], c);
    if ((recent?.n ?? 0) >= SHOWCASE_DAILY_MAX) throw E.conflict(`You've shared ${SHOWCASE_DAILY_MAX} moments today. Come back tomorrow!`, { nextPostAt: await nextPostAt(userId) });
    const comp = await one<{ name: string; level: number; palette: string; equipped_outfit: string; signature_move: string }>(
      'SELECT name, level, palette, equipped_outfit, signature_move FROM companions WHERE user_id = $1', [userId], c,
    );
    const plus = await isPlus(userId);
    // Plus companions wear the glow aura on top of their outfit; the app draws the aura when the label mentions it.
    const outfit = comp!.equipped_outfit;
    const label = !plus || outfit === 'aura' ? outfitName(outfit) : outfit === 'none' ? 'Glow aura' : `${outfitName(outfit)} + Glow aura`;
    const snapshot = { name: comp!.name, level: comp!.level, palette: comp!.palette, outfit: comp!.equipped_outfit, outfitLabel: label, signatureMove: comp!.signature_move };
    const p = await one<{ id: string }>('INSERT INTO showcase_posts (user_id, caption, image_url, activity, snapshot) VALUES ($1,$2,$3,$4,$5) RETURNING id', [userId, caption, imageUrl ?? null, activity ?? null, JSON.stringify(snapshot)], c);
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

/** Only the author can delete a post; it's gone from every feed (cheers and feed rows cascade). */
export async function deletePost(userId: string, postId: string) {
  const r = await q('DELETE FROM showcase_posts WHERE id = $1 AND user_id = $2 RETURNING id', [postId, userId]);
  if (r.length === 0) throw E.notFound('Post not found');
}
