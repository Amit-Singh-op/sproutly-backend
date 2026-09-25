import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  conversationDetail, createGroup, discoverGroups, joinGroup, leaveGroup, listConversations, openDm, patchMembership, receipts,
} from '../../core/conversations.js';
import { SendBody, deleteMessage, editMessage, history, markWatermark, sendMessage, vote } from '../../core/messages.js';

const Id = z.object({ id: z.string().uuid() });
const CreateConv = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dm'), userId: z.string().uuid() }),
  z.object({
    kind: z.literal('group'), title: z.string().trim().min(1).max(60), category: z.string().max(40).default('For you'),
    isPublic: z.boolean().default(false), avatarColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#2F8A6C'),
    memberIds: z.array(z.string().uuid()).max(499).default([]),
  }),
]);
const History = z.object({
  before_seq: z.coerce.number().int().min(0).optional(),
  after_seq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const UpTo = z.object({ upToSeq: z.number().int().min(0) });
const Membership = z.object({ mutedUntil: z.string().datetime().nullable().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() });

export async function chatRoutes(app: FastifyInstance) {
  app.get('/conversations', async (req) => listConversations(req.userId));

  app.post('/conversations', async (req) => {
    const b = CreateConv.parse(req.body);
    return b.kind === 'dm' ? openDm(req.userId, b.userId) : createGroup(req.userId, b);
  });

  app.get('/conversations/:id', async (req) => conversationDetail(req.userId, Id.parse(req.params).id));

  app.get('/conversations/:id/messages', async (req) => {
    const { id } = Id.parse(req.params);
    const qs = History.parse(req.query);
    return history(req.userId, id, { beforeSeq: qs.before_seq, afterSeq: qs.after_seq, limit: qs.limit });
  });

  /** REST fallback for msg:send; same validation, same idempotency. Returns the stored Message. */
  app.post('/conversations/:id/messages', async (req) => {
    const { id } = Id.parse(req.params);
    return sendMessage(req.userId, SendBody.parse({ ...(req.body as object), conversationId: id }));
  });

  app.get('/conversations/:id/receipts', async (req) => receipts(req.userId, Id.parse(req.params).id));

  // REST fallbacks for the socket's msg:delivered / msg:read (app uses them while realtime is down).
  app.post('/conversations/:id/delivered', async (req) => {
    await markWatermark(req.userId, Id.parse(req.params).id, UpTo.parse(req.body).upToSeq, 'delivered');
    return { ok: true };
  });
  app.post('/conversations/:id/read', async (req) => {
    await markWatermark(req.userId, Id.parse(req.params).id, UpTo.parse(req.body).upToSeq, 'read');
    return { ok: true };
  });

  app.patch('/conversations/:id/membership', async (req) => {
    await patchMembership(req.userId, Id.parse(req.params).id, Membership.parse(req.body));
    return { ok: true };
  });

  app.patch('/messages/:id', async (req) => {
    await editMessage(req.userId, Id.parse(req.params).id, z.object({ body: z.string() }).parse(req.body).body);
    return { ok: true };
  });
  app.delete('/messages/:id', async (req) => {
    await deleteMessage(req.userId, Id.parse(req.params).id);
    return { ok: true };
  });

  app.post('/messages/:id/vote', async (req) => vote(req.userId, Id.parse(req.params).id, z.object({ optionIdx: z.number().int().min(0) }).parse(req.body).optionIdx));
  app.delete('/messages/:id/vote', async (req) => vote(req.userId, Id.parse(req.params).id, null));

  app.get('/groups/discover', async (req) => {
    const { category } = z.object({ category: z.string().max(40).optional(), cursor: z.string().optional() }).parse(req.query);
    return discoverGroups(req.userId, category && category !== 'For you' ? category : undefined);
  });
  app.post('/groups/:id/join', async (req) => joinGroup(req.userId, Id.parse(req.params).id));
  app.post('/groups/:id/leave', async (req) => {
    await leaveGroup(req.userId, Id.parse(req.params).id);
    return { ok: true };
  });
}
