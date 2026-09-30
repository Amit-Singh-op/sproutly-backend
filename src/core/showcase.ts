import { one, q, tx } from '../db/pool.js';
import { E } from '../lib/errors.js';
import { enqueue } from '../lib/queues.js';
import { limit } from '../lib/ratelimit.js';
import { LIMITS, RATE_LIMITS, cleanText, initialsOf, outfitName } from '../shared/rules.js';
import { COMMENT_MAX, SHOWCASE_DAILY_MAX, type ShowcaseActivity, type ShowcaseComment, type ShowcaseKind, type ShowcasePost } from '../shared/types.js';
import { isPlus } from './entitlements.js';
import { isOwnCloudinaryUrl } from '../lib/cloudinary.js';
import { AUDIENCE } from './stories.js';

interface PostRow {
  id: string; user_id: string; caption: string; image_url: string | null; activity: ShowcaseActivity | null; snapshot: ShowcasePost['snapshot']; cheer_count: number; created_at: Date; kind: ShowcaseKind; comment_count: number;
  display_name: string; avatar_color: string; avatar_url: string | null; plus_active: boolean | null; cheered: boolean; top: boolean;
}

const POST_SELECT = `
  SELECT p.id, p.user_id, p.caption, p.image_url, p.activity, p.snapshot, p.cheer_count, p.created_at, p.kind, p.comment_count, u.display_name, u.avatar_color, u.avatar_url, e.plus_active,
         EXISTS (SELECT 1 FROM showcase_cheers sc WHERE sc.post_id = p.id AND sc.user_id = $1) AS cheered,
         EXISTS (SELECT 1 FROM weekly_top w WHERE w.post_id = p.id AND w.week_start = date_trunc('week', now())::date) AS top
    FROM showcase_posts p JOIN users u ON u.id = p.user_id LEFT JOIN entitlements e ON e.user_id = p.user_id`;

const toPost = (r: PostRow): ShowcasePost => ({
  id: r.id, userId: r.user_id, authorName: r.display_name, authorInitials: initialsOf(r.display_name), authorColor: r.avatar_color, authorUrl: r.avatar_url,
  // Gold card + badge only; no ranking boost for Plus (doc section 11).
  authorIsPlus: !!r.plus_active, caption: r.caption, imageUrl: r.image_url, activity: r.activity, createdAt: r.created_at.toISOString(), snapshot: r.snapshot,
  cheerCount: r.cheer_count, cheeredByMe: r.cheered, topOfWeek: r.top, kind: r.kind, commentCount: r.comment_count,
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
export async function createPost(userId: string, rawCaption: string, imageUrl?: string | null, activity?: ShowcaseActivity | null, kind?: ShowcaseKind): Promise<ShowcasePost> {
  const caption = cleanText(rawCaption ?? '').slice(0, 120);
  // Older apps don't send a kind: a post with no photo and no activity is a Mo update.
  const k: ShowcaseKind = kind ?? (imageUrl || activity ? 'day' : 'mo');
  if (k === 'mo') { imageUrl = null; activity = null; }
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
    const p = await one<{ id: string }>('INSERT INTO showcase_posts (user_id, caption, image_url, activity, snapshot, kind) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [userId, caption, imageUrl ?? null, activity ?? null, JSON.stringify(snapshot), k], c);
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

// ---------- comments (day posts only) ----------

interface CommentRow { id: string; post_id: string; user_id: string; body: string; created_at: Date; display_name: string; avatar_color: string; avatar_url: string | null; plus_active: boolean | null }
const toComment = (r: CommentRow): ShowcaseComment => ({
  id: r.id, postId: r.post_id, userId: r.user_id, authorName: r.display_name, authorInitials: initialsOf(r.display_name), authorColor: r.avatar_color,
  authorUrl: r.avatar_url, authorIsPlus: !!r.plus_active, body: r.body, createdAt: r.created_at.toISOString(),
});
const COMMENT_SELECT = `
  SELECT c.id, c.post_id, c.user_id, c.body, c.created_at, u.display_name, u.avatar_color, u.avatar_url, e.plus_active
    FROM showcase_comments c JOIN users u ON u.id = c.user_id LEFT JOIN entitlements e ON e.user_id = c.user_id`;
/** Hides comments between people who blocked each other. */
const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM friendships bl WHERE bl.status = 'blocked'
  AND ((bl.user_id = $1 AND bl.friend_id = c.user_id) OR (bl.user_id = c.user_id AND bl.friend_id = $1)))`;

/** A post you can see that takes comments. */
async function commentablePost(userId: string, postId: string) {
  const post = await getPost(userId, postId);
  if (post.kind !== 'day') throw E.badRequest("Mo updates don't take comments");
  return post;
}

export async function listComments(userId: string, postId: string): Promise<ShowcaseComment[]> {
  await commentablePost(userId, postId);
  const rows = await q<CommentRow>(`${COMMENT_SELECT} WHERE c.post_id = $2 AND ${NOT_BLOCKED} ORDER BY c.created_at ASC LIMIT 200`, [userId, postId]);
  return rows.map(toComment);
}

const recount = `UPDATE showcase_posts SET comment_count = (SELECT count(*) FROM showcase_comments WHERE post_id = $1) WHERE id = $1 RETURNING comment_count`;

export async function addComment(userId: string, postId: string, rawBody: string): Promise<{ comment: ShowcaseComment; commentCount: number }> {
  await limit(`comment:${userId}`, RATE_LIMITS.commentsPerUser);
  const body = cleanText(rawBody ?? '').slice(0, COMMENT_MAX);
  if (!body) throw E.badRequest('Write something first');
  await commentablePost(userId, postId);
  const { id, count } = await tx(async (c) => {
    const r = await one<{ id: string }>('INSERT INTO showcase_comments (post_id, user_id, body) VALUES ($1,$2,$3) RETURNING id', [postId, userId, body], c);
    const n = await one<{ comment_count: number }>(recount, [postId], c);
    return { id: r!.id, count: n!.comment_count };
  });
  const row = await one<CommentRow>(`${COMMENT_SELECT} WHERE c.id = $1`, [id]);
  return { comment: toComment(row!), commentCount: count };
}

/** The comment's author, or the post's owner, can delete it. */
export async function deleteComment(userId: string, commentId: string): Promise<{ postId: string; commentCount: number }> {
  return tx(async (c) => {
    const r = await one<{ post_id: string }>(
      `DELETE FROM showcase_comments sc USING showcase_posts p
        WHERE sc.id = $1 AND p.id = sc.post_id AND (sc.user_id = $2 OR p.user_id = $2) RETURNING sc.post_id`, [commentId, userId], c);
    if (!r) throw E.notFound('Comment not found');
    const n = await one<{ comment_count: number }>(recount, [r.post_id], c);
    return { postId: r.post_id, commentCount: n?.comment_count ?? 0 };
  });
}
