/**
 * 1v1 games: which games can be played head to head, and the rules of the turn-based board games. The server runs
 * these to check every move; the app uses the same code to draw boards and show wins. Mirrored in the app at
 * src/games/boards.ts; keep the two in sync.
 *
 * Players are 1 (the challenger, "a") and 2 (the friend who was challenged, "b").
 */
export const RACE_GAMES = ['catch', 'hop', 'stack', 'whack', 'memory', 'simon', 'cricket'] as const;
export const TURN_GAMES = ['ttt', 'c4', 'rps'] as const;
export type RaceGame = (typeof RACE_GAMES)[number];
export type TurnGame = (typeof TURN_GAMES)[number];
export type MatchGame = RaceGame | TurnGame;

export const isTurnGame = (g: string): g is TurnGame => (TURN_GAMES as readonly string[]).includes(g);
export const isMatchGame = (g: string): g is MatchGame => isTurnGame(g) || (RACE_GAMES as readonly string[]).includes(g);

export type Player = 1 | 2;
export type Cell = 0 | Player;
export type RpsPick = 'rock' | 'paper' | 'scissors';

export interface TttState { board: Cell[] }
export interface C4State { board: Cell[]; last?: number }
export interface RpsRound { a: RpsPick; b: RpsPick; winner: Cell }
/** `picked` says who has chosen this round (the picks themselves stay hidden until both have). */
export interface RpsState { rounds: RpsRound[]; a?: RpsPick | null; b?: RpsPick | null; aWins: number; bWins: number }
export type BoardState = TttState | C4State | RpsState;

export const C4_COLS = 7;
export const C4_ROWS = 6;
export const RPS_TO_WIN = 2; // best of three

export function initialState(game: TurnGame): BoardState {
  if (game === 'ttt') return { board: Array(9).fill(0) as Cell[] };
  if (game === 'c4') return { board: Array(C4_COLS * C4_ROWS).fill(0) as Cell[] };
  return { rounds: [], a: null, b: null, aWins: 0, bWins: 0 };
}

const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

/** The winning line in tic-tac-toe, if there is one. */
export function tttLine(board: Cell[]): number[] | null {
  for (const l of TTT_LINES) {
    const [x, y, z] = l as [number, number, number];
    if (board[x] && board[x] === board[y] && board[x] === board[z]) return l;
  }
  return null;
}

/** Four in a row through cell `at` (index = row * 7 + col, row 0 at the top), or null. */
export function c4Line(board: Cell[], at: number): number[] | null {
  const p = board[at];
  if (!p) return null;
  const r0 = Math.floor(at / C4_COLS), c0 = at % C4_COLS;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
    const line = [at];
    for (const s of [1, -1]) {
      let r = r0 + dr * s, c = c0 + dc * s;
      while (r >= 0 && r < C4_ROWS && c >= 0 && c < C4_COLS && board[r * C4_COLS + c] === p) { line.push(r * C4_COLS + c); r += dr * s; c += dc * s; }
    }
    if (line.length >= 4) return line;
  }
  return null;
}

/** The lowest empty cell in a column, or -1 when it's full. */
export function c4Drop(board: Cell[], col: number): number {
  for (let r = C4_ROWS - 1; r >= 0; r--) if (board[r * C4_COLS + col] === 0) return r * C4_COLS + col;
  return -1;
}

const BEATS: Record<RpsPick, RpsPick> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
export const rpsWinner = (a: RpsPick, b: RpsPick): Cell => (a === b ? 0 : BEATS[a] === b ? 1 : 2);

export type MoveResult = { state: BoardState; nextTurn: Player | null; winner: Cell; done: boolean };

/**
 * Applies a move for `player`. Throws an Error with a readable message when the move isn't allowed. For tic-tac-toe
 * and four in a row the caller checks it's this player's turn first; rock-paper-scissors is simultaneous.
 */
export function applyMove(game: TurnGame, state: BoardState, player: Player, move: unknown): MoveResult {
  if (game === 'ttt') {
    const s = state as TttState;
    const i = Number(move);
    if (!Number.isInteger(i) || i < 0 || i > 8) throw new Error('Pick a square');
    if (s.board[i] !== 0) throw new Error('That square is taken');
    const board = [...s.board]; board[i] = player;
    const line = tttLine(board);
    const full = board.every((c) => c !== 0);
    return { state: { board }, nextTurn: line || full ? null : player === 1 ? 2 : 1, winner: line ? player : 0, done: !!line || full };
  }
  if (game === 'c4') {
    const s = state as C4State;
    const col = Number(move);
    if (!Number.isInteger(col) || col < 0 || col >= C4_COLS) throw new Error('Pick a column');
    const at = c4Drop(s.board, col);
    if (at < 0) throw new Error('That column is full');
    const board = [...s.board]; board[at] = player;
    const line = c4Line(board, at);
    const full = board.every((c) => c !== 0);
    return { state: { board, last: at }, nextTurn: line || full ? null : player === 1 ? 2 : 1, winner: line ? player : 0, done: !!line || full };
  }
  const s = state as RpsState;
  if (move !== 'rock' && move !== 'paper' && move !== 'scissors') throw new Error('Pick rock, paper or scissors');
  const key = player === 1 ? 'a' : 'b';
  if (s[key]) throw new Error('You already picked this round');
  const next: RpsState = { ...s, rounds: [...s.rounds], [key]: move };
  if (next.a && next.b) {
    const w = rpsWinner(next.a, next.b);
    next.rounds.push({ a: next.a, b: next.b, winner: w });
    if (w === 1) next.aWins += 1; else if (w === 2) next.bWins += 1;
    next.a = null; next.b = null;
  }
  const done = next.aWins >= RPS_TO_WIN || next.bWins >= RPS_TO_WIN;
  return { state: next, nextTurn: null, winner: done ? (next.aWins > next.bWins ? 1 : 2) : 0, done };
}

/** What one player may see: in rock-paper-scissors the other player's pick for the open round stays hidden. */
export function stateFor(game: TurnGame, state: BoardState, viewer: Player): BoardState & { picked?: { a: boolean; b: boolean } } {
  if (game !== 'rps') return state;
  const s = state as RpsState;
  return {
    ...s,
    a: viewer === 1 ? s.a ?? null : null,
    b: viewer === 2 ? s.b ?? null : null,
    picked: { a: !!s.a, b: !!s.b },
  };
}
