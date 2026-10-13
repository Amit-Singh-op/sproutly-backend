import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ActionBody, act, modLog, queue, searchPeople, userDetail } from '../../core/admin.js';

const Id = z.object({ id: z.string().uuid() });

/** Moderation tools. Every handler checks the caller is an admin (core/admin.ts), so the app hiding them isn't the guard. */
export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/queue', async (req) => queue(req.userId));
  app.get('/admin/log', async (req) => modLog(req.userId));
  app.get('/admin/search', async (req) => searchPeople(req.userId, z.object({ q: z.string().trim().min(1).max(60) }).parse(req.query).q));
  app.get('/admin/users/:id', async (req) => userDetail(req.userId, Id.parse(req.params).id));
  app.post('/admin/users/:id/action', async (req) => act(req.userId, Id.parse(req.params).id, ActionBody.parse(req.body)));
}
