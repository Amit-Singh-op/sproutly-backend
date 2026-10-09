/**
 * Minigames: runs are started and finished on the server, so the run's length is measured here and a score that's
 * impossible for that time is not counted. Coins per run and per day are capped; best scores feed the weekly and
 * all-time leaderboards (everyone, friends, or one group).
 */
import type pg from 'pg';
import { one, q, tx } from '../db/pool.js';
import { toUser } from '../lib/emitter.js';
import { AppError, E } from '../lib/errors.js';
import { localDay } from '../lib/time.js';
import {
  GAME_DAILY_COINS, GAME_DAILY_COINS_PLUS, GAME_IDS, GAME_SESSION_MAX_S, coinsFor, plausible, weekEndsAt, weekKey,
  type GameId,
} from '../shared/games.js';
import { initialsOf } from '../shared/rules.js';
import type { EquippedSlots, Outfit, PaletteId } from '../shared/types.js';
import { isPlus } from './entitlements.js';
import { adjustCoinsTx } from './ledger.js';
import { slotsOf } from './users.js';

export type Period = 'week' | 'all';
export type Scope = 'all' | 'friends' | 'group';

export interface GameStat { id: GameId; best: number; weekBest: number; playsToday: number }
export interface GamesHome { games: GameStat[]; coinsToday: number; dailyCap: number; weekEndsAt: string }

export interface BoardEntry {
  rank: number; userId: string; displayName: string; initials: string; avatarColor: string; avatarUrl: string | null;
  score: number; me: boolean;
  mo: { palette: PaletteId; level: number; outfit: Outfit; equippedSlots: EquippedSlots };
}
export interface Board { game: GameId; period: Period; scope: Scope; entries: BoardEntry[]; me: BoardEntry | null; weekEndsAt: string }

export interface FinishResult {
  counted: boolean; message?: string;
  score: number; coins: number; wallet: number | null; coinsToday: number; dailyCap: number;
  best: number; weekBest: number; newBest: boolean; newWeekBest: boolean; weekRank: number | null;
}

const BOARD_SIZE = 50;

async function today(userId: string, db?: pg.PoolClient): Promise<string> {
  const u = await one<{ timezone: string }>('SELECT timezone FROM users WHERE id = $1', [userId], db);
  return localDay(u?.timezone || 'UTC');
}

async function coinsToday(userId: string, day: string, db?: pg.PoolClient): Promise<number> {
  const r = await one<{ n: string }>('SELECT COALESCE(SUM(coins), 0) AS n FROM game_sessions WHERE user_id = $1 AND local_day = $2', [userId, day], db);
  return Number(r?.n ?? 0);
}

const capFor = async (userId: string) => ((await isPlus(userId)) ? GAME_DAILY_COINS_PLUS : GAME_DAILY_COINS);

export async function gamesHome(userId: string): Promise<GamesHome> {
  const day = await today(userId);
  const week = weekKey();
  const [bests, plays, earned, cap] = await Promise.all([
    q<{ game: string; period: string; score: number }>(
      'SELECT game, period, score FROM game_bests WHERE user_id = $1 AND period IN ($2, $3)', [userId, 'all', week]),
    q<{ game: string; n: string }>(
      'SELECT game, COUNT(*) AS n FROM game_sessions WHERE user_id = $1 AND local_day = $2 AND finished_at IS NOT NULL GROUP BY game', [userId, day]),
    coinsToday(userId, day),
    capFor(userId),
  ]);
  const best = (g: string, p: string) => bests.find((b) => b.game === g && b.period === p)?.score ?? 0;
  return {
    games: GAME_IDS.map((id) => ({ id, best: best(id, 'all'), weekBest: best(id, week), playsToday: Number(plays.find((p) => p.game === id)?.n ?? 0) })),
    coinsToday: earned, dailyCap: cap, weekEndsAt: weekEndsAt(),
  };
}

export async function startGame(userId: string, game: GameId): Promise<{ sessionId: string; startedAt: string }> {
  // Runs started but never finished in the last hour: a script opening hundreds is stopped (rate limits do the rest).
  const open = await one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM game_sessions WHERE user_id = $1 AND finished_at IS NULL AND started_at > now() - interval '1 hour'`, [userId]);
  if (Number(open?.n ?? 0) >= 40) throw E.rateLimited("You've started a lot of games. Finish one first.");
  const r = await one<{ id: string; started_at: Date }>(
    'INSERT INTO game_sessions (user_id, game) VALUES ($1, $2) RETURNING id, started_at', [userId, game]);
  return { sessionId: r!.id, startedAt: r!.started_at.toISOString() };
}

export async function finishGame(userId: string, sessionId: string, score: number): Promise<FinishResult> {
  const cap = await capFor(userId);
  const week = weekKey();
  const out = await tx(async (c) => {
    const s = await one<{ game: GameId; finished_at: Date | null; score: number | null; coins: number; flagged: boolean; elapsed: number }>(
      `SELECT game, finished_at, score, coins, flagged, EXTRACT(EPOCH FROM (now() - started_at))::float AS elapsed
         FROM game_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE`, [sessionId, userId], c);
    if (!s) throw E.notFound('That game was not found');
    const day = await today(userId, c);
    if (s.finished_at) throw new AppError(409, 'ALREADY_FINISHED', 'That game was already counted');
    if (s.elapsed > GAME_SESSION_MAX_S) {
      await q('UPDATE game_sessions SET finished_at = now(), score = $2, local_day = $3 WHERE id = $1', [sessionId, score, day], c);
      return { counted: false, message: 'That game took too long to count. Start a new one!', game: s.game, score, coins: 0, wallet: null, day };
    }
    if (!plausible(s.game, score, s.elapsed)) {
      await q('UPDATE game_sessions SET finished_at = now(), score = $2, flagged = TRUE, local_day = $3 WHERE id = $1', [sessionId, score, day], c);
      return { counted: false, message: "That score couldn't be counted.", game: s.game, score, coins: 0, wallet: null, day };
    }

    const earned = await coinsToday(userId, day, c);
    const coins = Math.max(0, Math.min(coinsFor(s.game, score), cap - earned));
    await q('UPDATE game_sessions SET finished_at = now(), score = $2, coins = $3, local_day = $4 WHERE id = $1', [sessionId, score, coins, day], c);
    let wallet: number | null = null;
    if (coins > 0) wallet = (await adjustCoinsTx(c, userId, coins, 'game', `game:${sessionId}`)).coins;

    const prev = await q<{ period: string; score: number }>(
      'SELECT period, score FROM game_bests WHERE user_id = $1 AND game = $2 AND period IN ($3, $4) FOR UPDATE', [userId, s.game, 'all', week], c);
    const prevAll = prev.find((p) => p.period === 'all')?.score ?? 0;
    const prevWeek = prev.find((p) => p.period === week)?.score ?? 0;
    if (score > 0) {
      for (const period of ['all', week]) {
        await q(
          `INSERT INTO game_bests (user_id, game, period, score, achieved_at) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (user_id, game, period) DO UPDATE SET score = EXCLUDED.score, achieved_at = now() WHERE game_bests.score < EXCLUDED.score`,
          [userId, s.game, period, score], c);
      }
    }
    return {
      counted: true, game: s.game, score, coins, wallet, day,
      best: Math.max(prevAll, score), weekBest: Math.max(prevWeek, score),
      newBest: score > prevAll && prevAll > 0, newWeekBest: score > prevWeek && score > 0,
    };
  });

  if (out.wallet != null) toUser(userId, 'wallet:update', { coins: out.wallet });
  const total = await coinsToday(userId, out.day);
  if (!out.counted) {
    const home = await gamesHome(userId);
    const stat = home.games.find((g) => g.id === out.game)!;
    return { counted: false, message: out.message, score: out.score, coins: 0, wallet: null, coinsToday: total, dailyCap: cap,
      best: stat.best, weekBest: stat.weekBest, newBest: false, newWeekBest: false, weekRank: null };
  }
  const board = await leaderboard(userId, out.game, 'week', 'all');
  return {
    counted: true, score: out.score, coins: out.coins, wallet: out.wallet, coinsToday: total, dailyCap: cap,
    best: out.best!, weekBest: out.weekBest!, newBest: out.newBest!, newWeekBest: out.newWeekBest!, weekRank: board.me?.rank ?? null,
  };
}

interface BoardRow {
  user_id: string; score: number; rank: string; display_name: string; avatar_color: string; avatar_url: string | null;
  palette: PaletteId; level: number; equipped_outfit: Outfit; equipped_slots: EquippedSlots | null;
}

export async function leaderboard(userId: string, game: GameId, period: Period, scope: Scope, groupId?: string): Promise<Board> {
  const key = period === 'week' ? weekKey() : 'all';
  const params: unknown[] = [game, key, userId];
  let filter = '';
  if (scope === 'friends') {
    filter = `AND (b.user_id = $3 OR b.user_id IN (SELECT friend_id FROM friendships WHERE user_id = $3 AND status = 'accepted'))`;
  } else if (scope === 'group') {
    if (!groupId) throw E.badRequest('Pick a group');
    const member = await one(
      `SELECT 1 FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1 AND m.user_id = $2 AND c.kind = 'group'`, [groupId, userId]);
    if (!member) throw E.forbidden("You're not in that group");
    params.push(groupId);
    filter = 'AND b.user_id IN (SELECT user_id FROM conversation_members WHERE conversation_id = $4)';
  }
  // People you blocked or who blocked you, and suspended accounts, are left out of every board.
  const rows = await q<BoardRow>(
    `WITH ranked AS (
       SELECT b.user_id, b.score, ROW_NUMBER() OVER (ORDER BY b.score DESC, b.achieved_at ASC) AS rank
         FROM game_bests b JOIN users u ON u.id = b.user_id
        WHERE b.game = $1 AND b.period = $2 AND u.suspended_at IS NULL ${filter}
          AND NOT EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'blocked'
                AND ((f.user_id = $3 AND f.friend_id = b.user_id) OR (f.user_id = b.user_id AND f.friend_id = $3)))
     )
     SELECT r.user_id, r.score, r.rank, u.display_name, u.avatar_color, u.avatar_url,
            c.palette, c.level, c.equipped_outfit, c.equipped_slots
       FROM ranked r JOIN users u ON u.id = r.user_id JOIN companions c ON c.user_id = r.user_id
      WHERE r.rank <= ${BOARD_SIZE} OR r.user_id = $3
      ORDER BY r.rank`, params);
  const entries = rows.map((r): BoardEntry => ({
    rank: Number(r.rank), userId: r.user_id, displayName: r.display_name, initials: initialsOf(r.display_name),
    avatarColor: r.avatar_color, avatarUrl: r.avatar_url, score: r.score, me: r.user_id === userId,
    mo: { palette: r.palette, level: r.level, outfit: r.equipped_outfit, equippedSlots: slotsOf(r.equipped_slots, r.equipped_outfit) },
  }));
  return {
    game, period, scope,
    entries: entries.filter((e) => e.rank <= BOARD_SIZE),
    me: entries.find((e) => e.me) ?? null,
    weekEndsAt: weekEndsAt(),
  };
}

