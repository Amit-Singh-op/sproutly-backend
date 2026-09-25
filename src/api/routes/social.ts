import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { currentEvent } from '../../core/conversations.js';
import { getDrop, claimDrop } from '../../core/drops.js';
import { listGuestbook, signGuestbook } from '../../core/guestbook.js';
import { cheerRoom, getRoom, invite, respond } from '../../core/rooms.js';
import { GUESTBOOK_STICKERS } from '../../shared/types.js';
import { LIMITS } from '../../shared/rules.js';
import { cheer, createPost, feed, getPost } from '../../core/showcase.js';
import { addFriend, blockUser, friends, removeFriend, search } from '../../core/users.js';

const Id = z.object({ id: z.string().uuid() });
const UserId = z.object({ userId: z.string().uuid() });

export async function socialRoutes(app: FastifyInstance) {
  app.get('/friends', async (req) => friends(req.userId));
  app.post('/friends/:id', async (req) => { await addFriend(req.userId, Id.parse(req.params).id); return { ok: true }; });
  app.delete('/friends/:id', async (req) => { await removeFriend(req.userId, Id.parse(req.params).id); return { ok: true }; });
  app.post('/users/:id/block', async (req) => { await blockUser(req.userId, Id.parse(req.params).id); return { ok: true }; });

  app.get('/search', async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(60) }).parse(req.query);
    return search(req.userId, q);
  });

  app.get('/events/current', async () => currentEvent());

  // Showcase
  app.get('/showcase/feed', async (req) => feed(req.userId));
  app.get('/showcase/posts/:id', async (req) => getPost(req.userId, Id.parse(req.params).id));
  app.post('/showcase/posts', async (req) => createPost(req.userId, z.object({ caption: z.string().max(200) }).parse(req.body).caption));
  app.post('/showcase/posts/:id/cheer', async (req) => cheer(req.userId, Id.parse(req.params).id, true));
  app.delete('/showcase/posts/:id/cheer', async (req) => cheer(req.userId, Id.parse(req.params).id, false));

  // Rooms. The app asks for "me" before it knows its id.
  app.get('/rooms/:userId', async (req) => {
    const raw = (req.params as { userId: string }).userId;
    return getRoom(req.userId, raw === 'me' ? req.userId : UserId.parse(req.params).userId);
  });
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

  // Daily drop
  app.get('/drops/today', async (req) => getDrop(req.userId));
  app.post('/drops/today/claim', async (req) => claimDrop(req.userId));
}
