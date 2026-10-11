import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { arcadeFriends, challenge, getMatch, leave, listMatches, move, raceFinish, raceProgress, respond } from '../../core/matches.js';
import { RACE_GAMES, TURN_GAMES } from '../../shared/boards.js';

const Id = z.object({ id: z.string().uuid() });

export async function matchRoutes(app: FastifyInstance) {
  app.get('/arcade/friends', async (req) => arcadeFriends(req.userId));
  app.get('/matches', async (req) => listMatches(req.userId));
  app.get('/matches/:id', async (req) => getMatch(req.userId, Id.parse(req.params).id));
  app.post('/matches', async (req) => {
    const b = z.object({ opponentId: z.string().uuid(), game: z.enum([...RACE_GAMES, ...TURN_GAMES]) }).parse(req.body);
    return challenge(req.userId, b.opponentId, b.game);
  });
  app.post('/matches/:id/respond', async (req) => respond(req.userId, Id.parse(req.params).id, z.object({ accept: z.boolean() }).parse(req.body).accept));
  app.post('/matches/:id/leave', async (req) => leave(req.userId, Id.parse(req.params).id));
  app.post('/matches/:id/move', async (req) => move(req.userId, Id.parse(req.params).id, z.object({ move: z.union([z.number().int(), z.string().max(12)]) }).parse(req.body).move));
  app.post('/matches/:id/progress', async (req) => {
    await raceProgress(req.userId, Id.parse(req.params).id, z.object({ score: z.number().int().min(0).max(1_000_000) }).parse(req.body).score);
    return { ok: true };
  });
  app.post('/matches/:id/finish', async (req) => raceFinish(req.userId, Id.parse(req.params).id, z.object({ score: z.number().int().min(0).max(1_000_000) }).parse(req.body).score));
}
