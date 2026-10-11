import { describe, expect, it } from 'vitest';
import { applyMove, c4Drop, initialState, stateFor, type C4State, type RpsState, type TttState } from '../src/shared/boards.js';

describe('tic-tac-toe', () => {
  it('plays to a win and refuses taken squares', () => {
    let s = initialState('ttt');
    for (const [p, i] of [[2, 0], [1, 3], [2, 1], [1, 4]] as const) s = applyMove('ttt', s, p, i).state;
    expect(() => applyMove('ttt', s, 2, 0)).toThrow('taken');
    const r = applyMove('ttt', s, 2, 2);
    expect(r.done).toBe(true);
    expect(r.winner).toBe(2);
  });
  it('ends in a draw when the board fills', () => {
    const moves: [1 | 2, number][] = [[1, 0], [2, 1], [1, 2], [2, 4], [1, 3], [2, 5], [1, 7], [2, 6], [1, 8]];
    let s = initialState('ttt'); let last;
    for (const [p, i] of moves) { last = applyMove('ttt', s, p, i); s = last.state; }
    expect(last!.done).toBe(true);
    expect(last!.winner).toBe(0);
    expect((s as TttState).board.every((c) => c !== 0)).toBe(true);
  });
});

describe('four in a row', () => {
  it('drops to the bottom and finds four across', () => {
    let s = initialState('c4') as C4State;
    expect(c4Drop(s.board, 3)).toBe(38);
    let r;
    for (const col of [0, 1, 2]) { s = applyMove('c4', s, 1, col).state as C4State; s = applyMove('c4', s, 2, col).state as C4State; }
    r = applyMove('c4', s, 1, 3);
    expect(r.done).toBe(true);
    expect(r.winner).toBe(1);
  });
  it('finds four down and refuses a full column', () => {
    let s = initialState('c4') as C4State;
    for (let i = 0; i < 3; i++) { s = applyMove('c4', s, 2, 6).state as C4State; s = applyMove('c4', s, 1, 5).state as C4State; }
    expect(applyMove('c4', s, 2, 6).winner).toBe(2);
    let full = initialState('c4') as C4State;
    for (let i = 0; i < 6; i++) full = applyMove('c4', full, (i % 2 ? 2 : 1), 0).state as C4State;
    expect(() => applyMove('c4', full, 1, 0)).toThrow('full');
  });
});

describe('rock paper scissors', () => {
  it('hides the other pick until both chose, best of three', () => {
    let s = initialState('rps');
    s = applyMove('rps', s, 1, 'rock').state;
    expect((stateFor('rps', s, 2) as RpsState).a).toBeNull();
    expect(stateFor('rps', s, 2).picked).toEqual({ a: true, b: false });
    expect(() => applyMove('rps', s, 1, 'paper')).toThrow('already');
    let r = applyMove('rps', s, 2, 'scissors');
    expect((r.state as RpsState).aWins).toBe(1);
    s = applyMove('rps', r.state, 1, 'paper').state;
    r = applyMove('rps', s, 2, 'rock');
    expect(r.done).toBe(true);
    expect(r.winner).toBe(1);
  });
});
