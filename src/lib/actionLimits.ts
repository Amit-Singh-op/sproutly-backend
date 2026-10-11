/**
 * Per-account limits on every signed-in request: an overall cap (stops a script even when it hops between networks)
 * and a limit per action, each with a message people understand. Generous for real use; a modified app or a script
 * hitting an action over and over gets stopped with "try again in …".
 * (Messages, stickers, cheers, comments, uploads and analytics have their own limits where they're handled.)
 */
import type { FastifyRequest } from 'fastify';
import { limit } from './ratelimit.js';

type Rule = { points: number; windowS: number; message: string };
const MIN = 60, HOUR = 3600, DAY = 86400;

/** Everything one account does, all actions together. A busy session makes a few requests a second at most. */
const OVERALL: Rule = { points: 300, windowS: MIN, message: "You're doing that a lot. Slow down a little." };

/** Keyed by "METHOD /route" as Fastify registered it (with the /v1 prefix and :params). */
const ACTIONS: Record<string, Rule> = {
  'POST /v1/reports': { points: 20, windowS: HOUR, message: "You've sent a lot of reports. Thanks for helping keep Sproutly safe." },
  'POST /v1/users/:id/block': { points: 30, windowS: HOUR, message: "You've blocked a lot of people recently." },
  'POST /v1/friends/:id': { points: 30, windowS: HOUR, message: "You've sent a lot of friend requests." },
  'DELETE /v1/friends/:id': { points: 60, windowS: HOUR, message: "You've removed a lot of friends recently." },
  'POST /v1/conversations': { points: 20, windowS: HOUR, message: "You've started a lot of new chats." },
  'POST /v1/groups/:id/join': { points: 30, windowS: HOUR, message: "You've joined a lot of groups recently." },
  'POST /v1/groups/:id/leave': { points: 30, windowS: HOUR, message: "You've left a lot of groups recently." },
  'PATCH /v1/conversations/:id/membership': { points: 60, windowS: HOUR, message: "You've changed a lot of chat settings." },
  'PATCH /v1/messages/:id': { points: 30, windowS: MIN, message: "You're editing messages too fast." },
  'DELETE /v1/messages/:id': { points: 30, windowS: MIN, message: "You're deleting messages too fast." },
  'POST /v1/messages/:id/vote': { points: 60, windowS: MIN, message: "You're voting too fast." },
  'DELETE /v1/messages/:id/vote': { points: 60, windowS: MIN, message: "You're voting too fast." },
  'POST /v1/stories': { points: 20, windowS: DAY, message: "You've shared a lot of stories today." },
  'DELETE /v1/stories/:id': { points: 30, windowS: HOUR, message: "You've deleted a lot of stories." },
  'POST /v1/showcase/posts': { points: 20, windowS: HOUR, message: "You've posted a lot." },
  'DELETE /v1/showcase/posts/:id': { points: 30, windowS: HOUR, message: "You've deleted a lot of posts." },
  'DELETE /v1/showcase/comments/:id': { points: 60, windowS: HOUR, message: "You've deleted a lot of comments." },
  'POST /v1/rooms/invites': { points: 30, windowS: HOUR, message: "You've sent a lot of room invites." },
  'POST /v1/rooms/:userId/guestbook': { points: 20, windowS: HOUR, message: "You've signed a lot of guestbooks." },
  'POST /v1/rooms/:userId/cheer': { points: 60, windowS: HOUR, message: "You've cheered a lot of rooms." },
  'POST /v1/companion/actions': { points: 60, windowS: MIN, message: 'Give your companion a moment to catch its breath.' },
  'PATCH /v1/companion': { points: 60, windowS: HOUR, message: "You've changed your companion a lot." },
  'PATCH /v1/companion/equip': { points: 120, windowS: MIN, message: "You're changing outfits really fast." },
  'PUT /v1/companion/looks/:idx': { points: 30, windowS: MIN, message: "You're saving looks too fast." },
  'POST /v1/catalog/buy': { points: 20, windowS: MIN, message: "You're buying too fast." },
  'POST /v1/shop/buy': { points: 20, windowS: MIN, message: "You're buying too fast." },
  'PATCH /v1/me': { points: 30, windowS: HOUR, message: "You've changed your profile a lot." },
  'PUT /v1/chat-style': { points: 30, windowS: HOUR, message: "You've changed your chat style a lot." },
  'POST /v1/devices': { points: 20, windowS: HOUR, message: 'Too many device updates.' },
  'POST /v1/drops/today/claim': { points: 20, windowS: MIN, message: 'Slow down a little.' },
  'POST /v1/egg/hatch': { points: 20, windowS: MIN, message: 'Slow down a little.' },
  'POST /v1/quests/chest/claim': { points: 20, windowS: MIN, message: 'Slow down a little.' },
  'POST /v1/games/:game/start': { points: 120, windowS: HOUR, message: "You've played a lot of games this hour. Give Mo a little break." },
  'POST /v1/games/sessions/:id/finish': { points: 120, windowS: HOUR, message: "You've played a lot of games this hour. Give Mo a little break." },
  'GET /v1/games/:game/leaderboard': { points: 120, windowS: MIN, message: 'Slow down a little.' },
  'POST /v1/friends/:id/accept': { points: 60, windowS: HOUR, message: "You've accepted a lot of requests recently." },
  'POST /v1/friends/:id/decline': { points: 60, windowS: HOUR, message: "You've declined a lot of requests recently." },
  'POST /v1/matches': { points: 30, windowS: HOUR, message: "You've sent a lot of challenges. Give your friends a moment." },
  'POST /v1/matches/:id/respond': { points: 60, windowS: HOUR, message: 'Slow down a little.' },
  'POST /v1/matches/:id/move': { points: 60, windowS: MIN, message: "You're moving too fast." },
  'POST /v1/matches/:id/progress': { points: 150, windowS: MIN, message: 'Slow down a little.' },
  'POST /v1/matches/:id/finish': { points: 20, windowS: MIN, message: 'Slow down a little.' },
  'POST /v1/purchases/sync': { points: 10, windowS: MIN, message: 'Slow down a little.' },
};

export async function actionGate(req: FastifyRequest) {
  const userId = req.userId;
  if (!userId) return;
  await limit(`acct:${userId}`, OVERALL, OVERALL.message);
  const key = `${req.method} ${req.routeOptions.url ?? ''}`;
  const rule = ACTIONS[key];
  if (rule) await limit(`act:${userId}:${key}`, rule, rule.message);
}
