import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { finishGame, gamesHome, leaderboard, startGame } from '../../core/games.js';
import { GAME_IDS } from '../../shared/games.js';

const Game = z.object({ game: z.enum(GAME_IDS) });

export async function gameRoutes(app: FastifyInstance) {
  app.get('/games', async (req) => gamesHome(req.userId));
  app.post('/games/:game/start', async (req) => startGame(req.userId, Game.parse(req.params).game));
  app.post('/games/sessions/:id/finish', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { score } = z.object({ score: z.number().int().min(0).max(1_000_000) }).parse(req.body);
    return finishGame(req.userId, id, score);
  });
  app.get('/games/:game/leaderboard', async (req) => {
    const { game } = Game.parse(req.params);
    const query = z.object({
      period: z.enum(['week', 'all']).default('week'),
      scope: z.enum(['all', 'friends', 'group']).default('all'),
      groupId: z.string().uuid().optional(),
    }).parse(req.query);
    return leaderboard(req.userId, game, query.period, query.scope, query.groupId);
  });
}
