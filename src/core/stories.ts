import { z } from 'zod';
import { one, q } from '../db/pool.js';
import { E } from '../lib/errors.js';
import { isOwnCloudinaryUrl } from '../lib/cloudinary.js';
import { cleanText, initialsOf } from '../shared/rules.js';
import { STORY_BGS, type NewStory, type Story, type StoryGroup } from '../shared/types.js';

/** Most active stories one person can have at once. */
const MAX_ACTIVE = 30;
const TEXT_MAX = 200;

/**
 * Who sees an author's stories (and Show off posts): themselves, friends, and anyone they share a chat with —
 * never across a block. `author` is a SQL expression for the author's id; the viewer is always $1.
 */
export const AUDIENCE = (author: string) => `(
  ${author} = $1
  OR EXISTS (SELECT 1 FROM friendships fr WHERE fr.status = 'accepted'
             AND ((fr.user_id = $1 AND fr.friend_id = ${author}) OR (fr.user_id = ${author} AND fr.friend_id = $1)))
  OR EXISTS (SELECT 1 FROM conversation_members a JOIN conversation_members b ON b.conversation_id = a.conversation_id
             WHERE a.user_id = $1 AND b.user_id = ${author})
) AND NOT EXISTS (SELECT 1 FROM friendships bl WHERE bl.status = 'blocked'
             AND ((bl.user_id = $1 AND bl.friend_id = ${author}) OR (bl.user_id = ${author} AND bl.friend_id = $1)))`;

export const NewStoryBody: z.ZodType<NewStory> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), imageUrl: z.string().url().max(500), text: z.string().max(TEXT_MAX).optional() }),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(TEXT_MAX), bg: z.enum(STORY_BGS) }),
]);

interface Row {
  id: string; user_id: string; kind: 'image' | 'text'; image_url: string | null; text: string | null; bg: string | null;
  created_at: Date; expires_at: Date; viewed: boolean; view_count: number;
  display_name: string; avatar_color: string; avatar_url: string | null;
}

/** Everyone's active stories the viewer may see: yours first, then people with unseen stories, newest first. */
export async function listStories(viewerId: string): Promise<StoryGroup[]> {
  const rows = await q<Row>(
    `SELECT s.id, s.user_id, s.kind, s.image_url, s.text, s.bg, s.created_at, s.expires_at,
            EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = s.id AND v.viewer_id = $1) AS viewed,
            CASE WHEN s.user_id = $1 THEN (SELECT count(*)::int FROM story_views v WHERE v.story_id = s.id) ELSE 0 END AS view_count,
            u.display_name, u.avatar_color, u.avatar_url
       FROM stories s JOIN users u ON u.id = s.user_id
      WHERE s.expires_at > now() AND ${AUDIENCE('s.user_id')}
      ORDER BY s.created_at ASC
      LIMIT 1000`, [viewerId],
  );
  const groups = new Map<string, StoryGroup & { latest: number }>();
  for (const r of rows) {
    const isMe = r.user_id === viewerId;
    let g = groups.get(r.user_id);
    if (!g) {
      g = { userId: r.user_id, displayName: r.display_name, initials: initialsOf(r.display_name), avatarColor: r.avatar_color,
        avatarUrl: r.avatar_url, isMe, hasUnseen: false, stories: [], latest: 0 };
      groups.set(r.user_id, g);
    }
    const story: Story = {
      id: r.id, kind: r.kind, imageUrl: r.image_url, text: r.text, bg: r.bg,
      createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(), viewedByMe: isMe || r.viewed,
      ...(isMe ? { viewCount: r.view_count } : {}),
    };
    g.stories.push(story);
    if (!story.viewedByMe) g.hasUnseen = true;
    g.latest = Math.max(g.latest, r.created_at.getTime());
  }
  return [...groups.values()]
    .sort((a, b) => (a.isMe !== b.isMe ? (a.isMe ? -1 : 1) : a.hasUnseen !== b.hasUnseen ? (a.hasUnseen ? -1 : 1) : b.latest - a.latest))
    .map(({ latest: _latest, ...g }) => g);
}

export async function createStory(userId: string, input: NewStory): Promise<StoryGroup[]> {
  const active = await one<{ n: number }>('SELECT count(*)::int AS n FROM stories WHERE user_id = $1 AND expires_at > now()', [userId]);
  if ((active?.n ?? 0) >= MAX_ACTIVE) throw E.badRequest(`You can have up to ${MAX_ACTIVE} stories at a time. Delete one to add more.`);
  if (input.kind === 'image') {
    if (!isOwnCloudinaryUrl(input.imageUrl, userId, 'stories')) throw E.badRequest('Upload the photo first, then post it.');
    const caption = input.text ? cleanText(input.text).slice(0, TEXT_MAX) : null;
    await q('INSERT INTO stories (user_id, kind, image_url, text) VALUES ($1, $2, $3, $4)', [userId, 'image', input.imageUrl, caption || null]);
  } else {
    const text = cleanText(input.text).slice(0, TEXT_MAX);
    if (!text) throw E.badRequest('Write something first');
    await q('INSERT INTO stories (user_id, kind, text, bg) VALUES ($1, $2, $3, $4)', [userId, 'text', text, input.bg]);
  }
  return listStories(userId);
}

/** Only the author can delete; it disappears for everyone right away. */
export async function deleteStory(userId: string, storyId: string) {
  const r = await q('DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING id', [storyId, userId]);
  if (r.length === 0) throw E.notFound('Story not found');
}

/** Records a view (idempotent). Viewing your own story doesn't count. */
export async function viewStory(userId: string, storyId: string) {
  await q(
    `INSERT INTO story_views (story_id, viewer_id)
     SELECT s.id, $1 FROM stories s WHERE s.id = $2 AND s.user_id <> $1 AND s.expires_at > now() AND ${AUDIENCE('s.user_id')}
     ON CONFLICT DO NOTHING`, [userId, storyId],
  );
}
