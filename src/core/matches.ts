/**
 * 1v1 matches between friends.
 *
 * - Race (any minigame): the friend accepts, both apps count down to the same `starts_at` and play; each player's
 *   score streams to the other while they play, and the final score is checked against the time since the start
 *   (same limits as solo games). Higher score wins. Someone who never finishes counts as 0 after a few minutes.
 * - Turn (tic-tac-toe, four in a row, rock-paper-scissors): the server holds the board and checks every move.
 *   A player who doesn't move for a day loses on time.
 *
 * Every change is pushed to both players (`match:update`); the person who has to act also gets a notification.
 * Invites lapse after INVITE_MIN minutes. Stale states are settled lazily whenever a match is read.
 */
import type pg from 'pg';
import { one, q, tx } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { applyMove, initialState, isTurnGame, stateFor, type BoardState, type MatchGame, type Player, type TurnGame } from '../shared/boards.js';
import { GAMES, isGameId, plausible } from '../shared/games.js';
import { initialsOf } from '../shared/rules.js';
import type { ArcadeFriend, EquippedSlots, Match, MatchPlayer, Outfit, PaletteId } from '../shared/types.js';
import { onlineMap } from '../lib/presence.js';
import { notifyActivity } from './activity.js';
import { nameOf, notifyPush, relation } from './friends.js';
import { slotsOf } from './users.js';

const INVITE_MIN = 10;
/** Countdown both players see before a race starts. */
const RACE_LEAD_MS = 5000;
/** A race nobody finished settles this long after it started. */
const RACE_MAX_MS = 4 * 60_000;
/** A turn game with no move for this long is lost by whoever had to move. */
const TURN_TIMEOUT_H = 24;
const OPEN_INVITES_MAX = 5;

const TURN_NAMES: Record<TurnGame, string> = { ttt: 'Tic-Tac-Toe', c4: 'Four in a Row', rps: 'Rock Paper Scissors' };
export const gameName = (g: string) => (isTurnGame(g) ? TURN_NAMES[g] : isGameId(g) ? GAMES[g].name : 'a game');

interface Row {
  id: string; game: MatchGame; kind: 'race' | 'turn'; a_id: string; b_id: string; status: Match['status']; state: BoardState;
  a_score: number | null; b_score: number | null; winner_id: string | null; turn_id: string | null; end_reason: Match['endReason'];
  starts_at: Date | null; created_at: Date; updated_at: Date; finished_at: Date | null;
}

async function players(ids: string[]): Promise<Record<string, MatchPlayer>> {
  const rows = await q<{ id: string; display_name: string; avatar_color: string; avatar_url: string | null; palette: PaletteId; level: number; equipped_outfit: Outfit; equipped_slots: EquippedSlots | null }>(
    `SELECT u.id, u.display_name, u.avatar_color, u.avatar_url, c.palette, c.level, c.equipped_outfit, c.equipped_slots
       FROM users u JOIN companions c ON c.user_id = u.id WHERE u.id = ANY($1::uuid[])`, [ids]);
  const out: Record<string, MatchPlayer> = {};
  for (const r of rows) {
    out[r.id] = { id: r.id, displayName: r.display_name, initials: initialsOf(r.display_name), avatarColor: r.avatar_color, avatarUrl: r.avatar_url,
      palette: r.palette, level: r.level, outfit: r.equipped_outfit, equippedSlots: slotsOf(r.equipped_slots, r.equipped_outfit) };
  }
  return out;
}

function view(r: Row, viewer: string, ps: Record<string, MatchPlayer>): Match {
  const you: Player = viewer === r.a_id ? 1 : 2;
  const gone = (id: string): MatchPlayer => ({ id, displayName: 'Someone', initials: '?', avatarColor: '#6B6480', avatarUrl: null, palette: 'mo', level: 1, outfit: 'none', equippedSlots: {} });
  return {
    id: r.id, game: r.game, kind: r.kind, status: r.status, you,
    a: ps[r.a_id] ?? gone(r.a_id), b: ps[r.b_id] ?? gone(r.b_id),
    aScore: r.a_score, bScore: r.b_score, winnerId: r.winner_id, turnId: r.turn_id, endReason: r.end_reason,
    startsAt: r.starts_at?.toISOString() ?? null,
    expiresAt: r.status === 'invited' ? new Date(r.created_at.getTime() + INVITE_MIN * 60_000).toISOString() : null,
    state: r.kind === 'turn' && isTurnGame(r.game) ? stateFor(r.game, r.state, you) : null,
    createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

/** Send the match to both players, each with their own view (hidden picks stay hidden). */
async function broadcast(r: Row) {
  const ps = await players([r.a_id, r.b_id]);
  toUser(r.a_id, 'match:update', view(r, r.a_id, ps));
  toUser(r.b_id, 'match:update', view(r, r.b_id, ps));
}

const SELECT = 'SELECT * FROM game_matches';

/** Settle anything that ran out of time (lapsed invite, unfinished race, a turn nobody took). Returns the row as it is now. */
async function settle(r: Row, c?: pg.PoolClient): Promise<Row> {
  const now = Date.now();
  if (r.status === 'invited' && now > r.created_at.getTime() + INVITE_MIN * 60_000) {
    return (await one<Row>(`UPDATE game_matches SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'invited' RETURNING *`, [r.id], c)) ?? r;
  }
  if (r.status === 'active' && r.kind === 'race' && r.starts_at && now > r.starts_at.getTime() + RACE_MAX_MS) {
    const a = r.a_score ?? 0, b = r.b_score ?? 0;
    const winner = a === b ? null : a > b ? r.a_id : r.b_id;
    const done = await one<Row>(
      `UPDATE game_matches SET status = 'done', a_score = $2, b_score = $3, winner_id = $4, end_reason = 'timeout', finished_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'active' RETURNING *`, [r.id, a, b, winner], c);
    if (done) await afterFinish(done);
    return done ?? r;
  }
  if (r.status === 'active' && r.kind === 'turn' && now > r.updated_at.getTime() + TURN_TIMEOUT_H * 3600_000) {
    // rock-paper-scissors has no turn: whoever hasn't picked loses (both missing = a draw).
    let winner: string | null = null;
    if (r.turn_id) winner = r.turn_id === r.a_id ? r.b_id : r.a_id;
    else if (r.game === 'rps') {
      const s = r.state as { a?: string | null; b?: string | null };
      winner = s.a && !s.b ? r.a_id : s.b && !s.a ? r.b_id : null;
    }
    const done = await one<Row>(
      `UPDATE game_matches SET status = 'done', winner_id = $2, end_reason = 'timeout', finished_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'active' RETURNING *`, [r.id, winner], c);
    if (done) await afterFinish(done);
    return done ?? r;
  }
  return r;
}

async function afterFinish(r: Row) {
  await broadcast(r);
  const name = gameName(r.game);
  for (const [me, them] of [[r.a_id, r.b_id], [r.b_id, r.a_id]] as const) {
    const result = r.winner_id === null ? 'draw' : r.winner_id === them ? 'win' : 'loss';
    // The feed row is from the other player's side: "X beat you", "you beat X", "you drew".
    await notifyActivity([me], them, 'match_result', { gameName: name, result }, `mres:${r.id}:${me}`);
  }
}

async function load(id: string, me: string, c?: pg.PoolClient, lock = false): Promise<Row> {
  const r = await one<Row>(`${SELECT} WHERE id = $1 AND (a_id = $2 OR b_id = $2)${lock ? ' FOR UPDATE' : ''}`, [id, me], c);
  if (!r) throw E.notFound('That match was not found');
  return r;
}

export async function getMatch(me: string, id: string): Promise<Match> {
  const r = await settle(await load(id, me));
  return view(r, me, await players([r.a_id, r.b_id]));
}

/** Your open invites (both ways), matches in play, and the last few finished ones. */
export async function listMatches(me: string): Promise<Match[]> {
  const rows = await q<Row>(
    `(${SELECT} WHERE (a_id = $1 OR b_id = $1) AND status IN ('invited', 'active') ORDER BY updated_at DESC LIMIT 30)
     UNION ALL
     (${SELECT} WHERE (a_id = $1 OR b_id = $1) AND status = 'done' ORDER BY finished_at DESC LIMIT 15)`, [me]);
  const settled = await Promise.all(rows.map((r) => settle(r)));
  const ps = await players([...new Set(settled.flatMap((r) => [r.a_id, r.b_id]))]);
  return settled.filter((r) => r.status !== 'expired').map((r) => view(r, me, ps));
}

export async function challenge(me: string, opponent: string, game: MatchGame): Promise<Match> {
  if (me === opponent) throw E.badRequest("You can't challenge yourself");
  if ((await relation(me, opponent)) !== 'friends') throw new AppError(403, 'NOT_FRIENDS', 'You can only challenge friends');
  const open = await q<Row>(`${SELECT} WHERE a_id = $1 AND status = 'invited'`, [me]);
  const live = (await Promise.all(open.map((r) => settle(r)))).filter((r) => r.status === 'invited');
  // Asking the same friend for the same game again just returns the invite that's already waiting.
  const same = live.find((r) => r.b_id === opponent && r.game === game);
  if (same) return view(same, me, await players([me, opponent]));
  if (live.length >= OPEN_INVITES_MAX) throw new AppError(429, 'RATE_LIMITED', 'You have a few challenges waiting already. Give your friends a moment to answer.');
  const kind = isTurnGame(game) ? 'turn' : 'race';
  const r = (await one<Row>(
    `INSERT INTO game_matches (game, kind, a_id, b_id, status) VALUES ($1, $2, $3, $4, 'invited') RETURNING *`, [game, kind, me, opponent]))!;
  await broadcast(r);
  const name = await nameOf(me);
  await notifyActivity([opponent], me, 'match_invite', { gameName: gameName(game) }, `minv:${r.id}`);
  notifyPush(opponent, `${name} challenged you!`, `${gameName(game)}, 1 vs 1. Tap to play.`, { type: 'match', matchId: r.id }, `minv:${r.id}`);
  return view(r, me, await players([me, opponent]));
}

export async function respond(me: string, id: string, accept: boolean): Promise<Match> {
  const r = await tx(async (c) => {
    const row = await settle(await load(id, me, c, true), c);
    if (row.b_id !== me) throw E.forbidden('Only the friend who was challenged can answer');
    if (row.status !== 'invited') throw new AppError(409, 'MATCH_CLOSED', row.status === 'expired' ? 'That challenge has expired' : 'That challenge is no longer open');
    if (!accept) return (await one<Row>(`UPDATE game_matches SET status = 'declined', updated_at = now() WHERE id = $1 RETURNING *`, [id], c))!;
    if (row.kind === 'race') {
      return (await one<Row>(
        `UPDATE game_matches SET status = 'active', starts_at = now() + make_interval(secs => $2), updated_at = now() WHERE id = $1 RETURNING *`,
        [id, RACE_LEAD_MS / 1000], c))!;
    }
    // Board games: the challenged friend moves first in tic-tac-toe and four in a row.
    const game = row.game as TurnGame;
    return (await one<Row>(
      `UPDATE game_matches SET status = 'active', state = $2::jsonb, turn_id = $3, starts_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(initialState(game)), game === 'rps' ? null : row.b_id], c))!;
  });
  await broadcast(r);
  if (accept) {
    const name = await nameOf(me);
    notifyPush(r.a_id, `${name} accepted!`, `${gameName(r.game)} is on. Tap to play.`, { type: 'match', matchId: r.id }, `macc:${r.id}`);
  }
  return view(r, me, await players([r.a_id, r.b_id]));
}

/** Cancel your invite, or leave a match in play (the other player wins). */
export async function leave(me: string, id: string): Promise<Match> {
  const r = await tx(async (c) => {
    const row = await settle(await load(id, me, c, true), c);
    if (row.status === 'invited') {
      if (row.a_id !== me) throw E.forbidden('Decline the challenge instead');
      return (await one<Row>(`UPDATE game_matches SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`, [id], c))!;
    }
    if (row.status !== 'active') return row;
    const winner = me === row.a_id ? row.b_id : row.a_id;
    return (await one<Row>(
      `UPDATE game_matches SET status = 'done', winner_id = $2, end_reason = 'forfeit', finished_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, winner], c))!;
  });
  if (r.status === 'done') await afterFinish(r); else await broadcast(r);
  return view(r, me, await players([r.a_id, r.b_id]));
}

/** Live race: your score so far, passed straight to the other player (nothing stored). */
export async function raceProgress(me: string, id: string, score: number) {
  const r = await load(id, me);
  if (r.status !== 'active' || r.kind !== 'race') return;
  toUser(me === r.a_id ? r.b_id : r.a_id, 'match:score', { matchId: id, userId: me, score });
}

/** Live race: your final score. The match finishes when both are in. */
export async function raceFinish(me: string, id: string, score: number): Promise<Match> {
  const r = await tx(async (c) => {
    const row = await settle(await load(id, me, c, true), c);
    if (row.kind !== 'race') throw E.badRequest('That match is not a race');
    if (row.status !== 'active') return row;
    const mine = me === row.a_id ? 'a_score' : 'b_score';
    if ((me === row.a_id ? row.a_score : row.b_score) != null) return row;
    const elapsed = row.starts_at ? (Date.now() - row.starts_at.getTime()) / 1000 : 0;
    // Same limits as a solo run: an impossible score for the time played counts as 0.
    const counted = isGameId(row.game) && plausible(row.game, score, elapsed) ? score : 0;
    let next = (await one<Row>(`UPDATE game_matches SET ${mine} = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, counted], c))!;
    if (next.a_score != null && next.b_score != null) {
      const winner = next.a_score === next.b_score ? null : next.a_score > next.b_score ? next.a_id : next.b_id;
      next = (await one<Row>(
        `UPDATE game_matches SET status = 'done', winner_id = $2, finished_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [id, winner], c))!;
    }
    return next;
  });
  if (r.status === 'done') await afterFinish(r); else await broadcast(r);
  return view(r, me, await players([r.a_id, r.b_id]));
}

/** Board games: make a move. */
export async function move(me: string, id: string, mv: unknown): Promise<Match> {
  const r = await tx(async (c) => {
    const row = await settle(await load(id, me, c, true), c);
    if (row.kind !== 'turn' || !isTurnGame(row.game)) throw E.badRequest('That match has no moves');
    if (row.status !== 'active') throw new AppError(409, 'MATCH_CLOSED', 'This match is over');
    if (row.turn_id && row.turn_id !== me) throw new AppError(409, 'NOT_YOUR_TURN', "It's not your turn yet");
    const player: Player = me === row.a_id ? 1 : 2;
    let res;
    try { res = applyMove(row.game, row.state, player, mv); } catch (e) { throw E.badRequest((e as Error).message); }
    const turn = res.nextTurn === null ? null : res.nextTurn === 1 ? row.a_id : row.b_id;
    if (res.done) {
      const winner = res.winner === 0 ? null : res.winner === 1 ? row.a_id : row.b_id;
      const s = res.state as { aWins?: number; bWins?: number };
      return (await one<Row>(
        `UPDATE game_matches SET state = $2::jsonb, turn_id = NULL, status = 'done', winner_id = $3, a_score = $4, b_score = $5, finished_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, JSON.stringify(res.state), winner, s.aWins ?? (winner === row.a_id ? 1 : 0), s.bWins ?? (winner === row.b_id ? 1 : 0)], c))!;
    }
    return (await one<Row>(`UPDATE game_matches SET state = $2::jsonb, turn_id = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(res.state), turn], c))!;
  });
  if (r.status === 'done') await afterFinish(r);
  else {
    await broadcast(r);
    if (r.turn_id && r.turn_id !== me) {
      notifyPush(r.turn_id, 'Your move!', `${await nameOf(me)} played in ${gameName(r.game)}.`, { type: 'match', matchId: r.id }, `mmove:${r.id}:${r.updated_at.getTime()}`);
    }
  }
  return view(r, me, await players([r.a_id, r.b_id]));
}

/** Friends for the Arcade: who's online and your record against each. */
export async function arcadeFriends(me: string): Promise<ArcadeFriend[]> {
  const rows = await q<{ id: string; display_name: string; handle: string; avatar_color: string; avatar_url: string | null; wins: string; losses: string; draws: string }>(
    `SELECT u.id, u.display_name, u.handle, u.avatar_color, u.avatar_url,
            COUNT(m.id) FILTER (WHERE m.winner_id = $1) AS wins,
            COUNT(m.id) FILTER (WHERE m.winner_id = u.id) AS losses,
            COUNT(m.id) FILTER (WHERE m.status = 'done' AND m.winner_id IS NULL) AS draws
       FROM friendships f JOIN users u ON u.id = f.friend_id
       LEFT JOIN game_matches m ON m.status = 'done' AND ((m.a_id = $1 AND m.b_id = u.id) OR (m.b_id = $1 AND m.a_id = u.id))
      WHERE f.user_id = $1 AND f.status = 'accepted' AND u.suspended_at IS NULL
      GROUP BY u.id ORDER BY u.display_name LIMIT 200`, [me]);
  const online = await onlineMap(rows.map((r) => r.id));
  return rows
    .map((r) => ({ id: r.id, displayName: r.display_name, handle: r.handle, avatarColor: r.avatar_color, avatarUrl: r.avatar_url,
      initials: initialsOf(r.display_name), online: online[r.id] ?? false, relation: 'friends' as const,
      wins: Number(r.wins), losses: Number(r.losses), draws: Number(r.draws) }))
    // Online friends first.
    .sort((x, y) => Number(y.online) - Number(x.online));
}
