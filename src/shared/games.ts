/**
 * Minigames: the list, how scores turn into coins, and the most a real player could score in a given time (the server
 * rejects anything above it). Mirrored in the app at src/games/rules.ts; keep the two in sync.
 */
export const GAME_IDS = ['catch', 'hop', 'memory', 'whack', 'simon', 'stack', 'cricket'] as const;
export type GameId = (typeof GAME_IDS)[number];

export interface GameDef {
  id: GameId;
  name: string;
  blurb: string;
  /** Points per coin earned (a run's coins = floor(score / pointsPerCoin), up to maxCoinsPerRun). */
  pointsPerCoin: number;
  maxCoinsPerRun: number;
  /** A finished run shorter than this is not counted (nobody really plays it that fast). */
  minSeconds: number;
  /** Highest score a real player can reach in `seconds` of play. */
  maxScore: (seconds: number) => number;
}

export const GAMES: Record<GameId, GameDef> = {
  catch: { id: 'catch', name: 'Fruit Catch', blurb: 'Slide Mo to catch fruit. Dodge the rocks!', pointsPerCoin: 3, maxCoinsPerRun: 25, minSeconds: 3,
    maxScore: (s) => Math.ceil(s * 6) + 10 },
  hop: { id: 'hop', name: 'Mo Hop', blurb: 'Tap to hop through the gaps.', pointsPerCoin: 1, maxCoinsPerRun: 25, minSeconds: 1,
    maxScore: (s) => Math.floor(s / 1.2) + 2 },
  memory: { id: 'memory', name: 'Memory Match', blurb: 'Flip cards and find every pair.', pointsPerCoin: 40, maxCoinsPerRun: 25, minSeconds: 6,
    maxScore: () => 1000 },
  whack: { id: 'whack', name: 'Pop-a-Mole', blurb: 'Tap the moles as they pop up. 30 seconds!', pointsPerCoin: 3, maxCoinsPerRun: 25, minSeconds: 28,
    maxScore: (s) => Math.ceil(Math.min(s, 40) * 4) },
  simon: { id: 'simon', name: 'Light Echo', blurb: 'Watch the lights, then repeat the pattern.', pointsPerCoin: 0.5, maxCoinsPerRun: 25, minSeconds: 1,
    maxScore: (s) => Math.floor(Math.sqrt(s / 0.25)) + 2 },
  stack: { id: 'stack', name: 'Sky Stack', blurb: 'Drop the blocks and build the tallest tower.', pointsPerCoin: 1.5, maxCoinsPerRun: 25, minSeconds: 1,
    maxScore: (s) => Math.floor(s / 0.45) + 2 },
  // Runs in 2 overs: at most a six a ball (72) plus a few wides, and every ball takes at least ~2.5s.
  cricket: { id: 'cricket', name: 'Cricket', blurb: 'Bat 2 overs and score as many runs as you can.', pointsPerCoin: 3, maxCoinsPerRun: 25, minSeconds: 6,
    maxScore: (s) => Math.min(90, Math.ceil(s * 3) + 6) },
};

/** Coins all games together can pay in one day (local day of the player). */
export const GAME_DAILY_COINS = 150;
export const GAME_DAILY_COINS_PLUS = 250;
/** A run has to be finished within this long after it started. */
export const GAME_SESSION_MAX_S = 30 * 60;

export const isGameId = (id: string): id is GameId => (GAME_IDS as readonly string[]).includes(id);

export function coinsFor(game: GameId, score: number): number {
  const g = GAMES[game];
  return Math.max(0, Math.min(g.maxCoinsPerRun, Math.floor(score / g.pointsPerCoin)));
}

/** Is this score possible for a run that lasted `seconds` (measured by the server)? */
export function plausible(game: GameId, score: number, seconds: number): boolean {
  if (!Number.isInteger(score) || score < 0) return false;
  if (score === 0) return true;
  const g = GAMES[game];
  return seconds >= g.minSeconds && score <= g.maxScore(seconds);
}

/** "2026-W41" (ISO week, UTC): weekly leaderboards reset every Monday 00:00 UTC. */
export function weekKey(at: Date = new Date()): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** When the current weekly leaderboard ends (next Monday 00:00 UTC). */
export function weekEndsAt(at: Date = new Date()): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + (8 - day));
  return d.toISOString();
}
