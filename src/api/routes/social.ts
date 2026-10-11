import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentEvent } from '../../core/conversations.js';
import { getDrop, claimDrop } from '../../core/drops.js';
import { listGuestbook, signGuestbook } from '../../core/guestbook.js';
import { cheerRoom, getRoom, invite, listInvites, respond } from '../../core/rooms.js';
import { COMMENT_MAX, GUESTBOOK_STICKERS, SHOWCASE_ACTIVITIES } from '../../shared/types.js';
import { LIMITS } from '../../shared/rules.js';
import { addComment, cheer, createPost, deleteComment, deletePost, feed, getPost, listComments } from '../../core/showcase.js';
import { NewStoryBody, createStory, deleteStory, listStories, viewStory } from '../../core/stories.js';
import { blockUser, friends, search } from '../../core/users.js';
import { acceptFriend, declineFriend, friendRequests, relation, removeFriendOrRequest, requestFriend } from '../../core/friends.js';
import { listActivity, markActivitySeen } from '../../core/activity.js';
import { plazaSpots } from '../../realtime/plaza.js';

const Id = z.object({ id: z.string().uuid() });
const UserId = z.object({ userId: z.string().uuid() });

export async function socialRoutes(app: FastifyInstance) {
  app.get('/friends', async (req) => friends(req.userId));
  // Friend requests: add sends one (or accepts theirs); accept/decline answer one; delete unfriends or cancels yours.
  app.get('/friends/requests', async (req) => friendRequests(req.userId));
  app.get('/users/:id/relation', async (req) => ({ relation: await relation(req.userId, Id.parse(req.params).id) }));
  app.post('/friends/:id', async (req) => ({ relation: await requestFriend(req.userId, Id.parse(req.params).id) }));
  app.post('/friends/:id/accept', async (req) => ({ relation: await acceptFriend(req.userId, Id.parse(req.params).id) }));
  app.post('/friends/:id/decline', async (req) => { await declineFriend(req.userId, Id.parse(req.params).id); return { relation: 'none' }; });
  app.delete('/friends/:id', async (req) => { await removeFriendOrRequest(req.userId, Id.parse(req.params).id); return { relation: 'none' }; });
  app.post('/users/:id/block', async (req) => { await blockUser(req.userId, Id.parse(req.params).id); return { ok: true }; });

  app.get('/search', async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(60) }).parse(req.query);
    return search(req.userId, q);
  });

  app.get('/events/current', async () => currentEvent());

  // Showcase
  app.get('/showcase/feed', async (req) => {
    const p = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), before: z.string().max(80).optional() }).parse(req.query);
    return feed(req.userId, p);
  });
  app.get('/showcase/posts/:id', async (req) => getPost(req.userId, Id.parse(req.params).id));
  app.post('/showcase/posts', async (req) => {
    const b = z.object({
      caption: z.string().max(200).default(''),
      imageUrl: z.string().url().max(500).nullable().optional(),
      activity: z.enum(SHOWCASE_ACTIVITIES).nullable().optional(),
      kind: z.enum(['day', 'mo']).optional(),
    }).parse(req.body);
    return createPost(req.userId, b.caption, b.imageUrl, b.activity, b.kind);
  });
  app.get('/showcase/posts/:id/comments', async (req) => {
    const p = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), before: z.string().max(40).optional() }).parse(req.query);
    return listComments(req.userId, Id.parse(req.params).id, p);
  });
  app.post('/showcase/posts/:id/comments', async (req) => {
    const { body } = z.object({ body: z.string().min(1).max(COMMENT_MAX * 2) }).parse(req.body);
    return addComment(req.userId, Id.parse(req.params).id, body);
  });
  app.delete('/showcase/comments/:id', async (req) => deleteComment(req.userId, Id.parse(req.params).id));
  app.delete('/showcase/posts/:id', async (req) => { await deletePost(req.userId, Id.parse(req.params).id); return { ok: true }; });
  app.post('/showcase/posts/:id/cheer', async (req) => cheer(req.userId, Id.parse(req.params).id, true));
  app.delete('/showcase/posts/:id/cheer', async (req) => cheer(req.userId, Id.parse(req.params).id, false));

  // Stories (24 h)
  app.get('/stories', async (req) => listStories(req.userId));
  app.post('/stories', async (req) => createStory(req.userId, NewStoryBody.parse(req.body)));
  app.delete('/stories/:id', async (req) => { await deleteStory(req.userId, Id.parse(req.params).id); return { ok: true }; });
  app.post('/stories/:id/view', async (req) => { await viewStory(req.userId, Id.parse(req.params).id); return { ok: true }; });

  // Rooms. The app asks for "me" before it knows its id.
  app.get('/rooms/:userId', async (req) => {
    const raw = (req.params as { userId: string }).userId;
    return getRoom(req.userId, raw === 'me' ? req.userId : UserId.parse(req.params).userId);
  });
  app.get('/rooms/invites', async (req) => listInvites(req.userId));
  app.post('/rooms/invites', async (req) => invite(req.userId, z.object({ guestId: z.string().uuid() }).parse(req.body).guestId));
  app.post('/rooms/invites/:id/respond', async (req) => {
    await respond(req.userId, Id.parse(req.params).id, z.object({ accept: z.boolean() }).parse(req.body).accept);
    return { ok: true };
  });
  app.post('/rooms/:userId/cheer', async (req) => { await cheerRoom(req.userId, UserId.parse(req.params).userId); return { ok: true }; });

  // Guestbook
  app.get('/rooms/:userId/guestbook', async (req) => {
    const raw = (req.params as { userId: string }).userId;
    return listGuestbook(req.userId, raw === 'me' ? req.userId : UserId.parse(req.params).userId);
  });
  app.post('/rooms/:userId/guestbook', async (req) => signGuestbook(req.userId, UserId.parse(req.params).userId,
    z.object({ sticker: z.enum(GUESTBOOK_STICKERS), note: z.string().max(LIMITS.guestbookNoteMax * 2).optional() }).parse(req.body)));

  // Plaza: live head counts per spot (joining happens over the socket).
  app.get('/plaza/spots', async () => plazaSpots());

  // Friend activity feed
  app.get('/activity', async (req) => listActivity(req.userId));
  app.post('/activity/seen', async (req) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).max(100).optional() }).parse(req.body ?? {});
    await markActivitySeen(req.userId, ids);
    return { ok: true };
  });

  // Daily drop
  app.get('/drops/today', async (req) => getDrop(req.userId));
  app.post('/drops/today/claim', async (req) => claimDrop(req.userId));
}
