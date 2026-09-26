// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Backgammon rules, as pure functions. The contract-canonical board layout and the one place the
 * rules are written in TypeScript: the website offers moves from `legalPlies`, the verifier
 * judges plies with `plyRuleViolation`, the CLI plays with both, and the contract tests hold
 * `applyPly` to the circuit (contract/src/backgammon-board.compact) move for move.
 *
 * BOARD LAYOUT -- identical to the contract's, never renumber. Each side is 26 counts from ITS
 * OWN point of view: index 0 = borne off, 1..24 = points (home is 1..6, a checker moves from p to
 * p - die), 25 = the bar. My point p is the opponent's index 25 - p.
 *
 * WHAT THE CHAIN CHECKS AND WHAT IT DOES NOT. `applyPly` is exactly the circuit: every checker
 * is legal against the board as it stands when it moves, and a die left unplayed must be
 * unplayable on the final board. The full "play as many dice as you can, and the larger if only
 * one" rule is NOT on chain -- it needs a search over orders -- and lives in `legalPlies` (which
 * only ever offers plies that obey it) and `plyRuleViolation` (which reports one that did not).
 */

export const BAR = 25;
export const OFF = 0;
export const CHECKERS = 15;
/** Sub-move slots in one ply: doubles play four. */
export const PLY_SLOTS = 4;

/** 26 counts: [off, point 1 .. point 24, bar]. */
export type Side = number[];

/** Both sides, each from its own point of view -- the contract's `Board`. */
export type Board = { s0: Side; s1: Side };

/** One checker moved: from a point (1..24) or the bar (25), by one die. */
export type SubMove = { point: number; die: number };

/** The sub-moves of one ply, in the order played. Empty = a pass. */
export type Ply = SubMove[];

/** The contract's argument shape: always four slots, unused ones `{0, 0}`. */
export type EncodedPly = { moves: SubMove[]; count: number };

export class IllegalPlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalPlyError';
  }
}

// ---------------------------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------------------------

/** One side at the start: two on 24, five on 13, three on 8, five on 6. */
export function initialSide(): Side {
  const s = new Array<number>(26).fill(0);
  s[24] = 2;
  s[13] = 5;
  s[8] = 3;
  s[6] = 5;
  return s;
}

export function initialBoard(): Board {
  return { s0: initialSide(), s1: initialSide() };
}

/** The mover's side and the opponent's, for `seat` to move. */
export function sidesFor(board: Board, seat: number): { mine: Side; opp: Side } {
  return seat === 0 ? { mine: board.s0, opp: board.s1 } : { mine: board.s1, opp: board.s0 };
}

/** Rebuild a `Board` from the mover's view. */
export function boardFrom(seat: number, mine: Side, opp: Side): Board {
  return seat === 0 ? { s0: mine, s1: opp } : { s0: opp, s1: mine };
}

/** Pips left to bear off: the race count. */
export function pipCount(side: Side): number {
  let n = 0;
  for (let p = 1; p <= BAR; p++) n += p * side[p];
  return n;
}

export function hasWon(side: Side): boolean {
  return side[OFF] === CHECKERS;
}

/** Every checker home (or off) -- the precondition for bearing off. */
export function allHome(side: Side): boolean {
  for (let p = 7; p <= BAR; p++) if (side[p] !== 0) return false;
  return true;
}

function checkSide(side: Side, who: string): void {
  if (side.length !== 26) throw new Error(`${who}: a side has 26 counts, got ${side.length}`);
  const total = side.reduce((a, b) => a + b, 0);
  if (total !== CHECKERS) throw new Error(`${who}: a side has ${CHECKERS} checkers, got ${total}`);
}

// ---------------------------------------------------------------------------------------------
// One checker
// ---------------------------------------------------------------------------------------------

/**
 * Why moving one checker from `point` by `die` is illegal right now, or `null` if it is legal.
 * The same checks, in the same order, as one sub-move of the circuit.
 */
export function subMoveViolation(mine: Side, opp: Side, point: number, die: number): string | null {
  if (!(die >= 1 && die <= 6)) return 'the die is not 1..6';
  if (!(point >= 1 && point <= BAR)) return 'the checker starts off the board';
  if (mine[point] === 0) return 'no checker of yours on that point';
  if (mine[BAR] !== 0 && point !== BAR) return 'a checker on the bar must enter first';
  const target = point - die;
  if (target >= 1) {
    if (opp[25 - target] >= 2) return 'the opponent holds the landing point';
    return null;
  }
  if (!allHome(mine)) return 'bearing off while a checker is outside the home board';
  if (target < 0) {
    for (let p = point + 1; p <= 6; p++) {
      if (mine[p] !== 0) return 'a larger die bears off only from the highest point';
    }
  }
  return null;
}

/** Move one checker, hitting a blot. Throws `IllegalPlyError` if the sub-move is illegal. */
export function applySubMove(
  mine: Side,
  opp: Side,
  sm: SubMove,
): { mine: Side; opp: Side; hit: boolean } {
  const why = subMoveViolation(mine, opp, sm.point, sm.die);
  if (why !== null) throw new IllegalPlyError(why);
  const m = mine.slice();
  const o = opp.slice();
  m[sm.point] -= 1;
  const target = sm.point - sm.die;
  let hit = false;
  if (target >= 1) {
    m[target] += 1;
    const q = 25 - target;
    if (o[q] === 1) {
      o[q] = 0;
      o[BAR] += 1;
      hit = true;
    }
  } else {
    m[OFF] += 1;
  }
  return { mine: m, opp: o, hit };
}

/** Can a checker move by `die` at all on this board? */
export function canPlayDie(mine: Side, opp: Side, die: number): boolean {
  for (let p = 1; p <= BAR; p++) {
    if (mine[p] !== 0 && subMoveViolation(mine, opp, p, die) === null) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// A ply, as the chain checks it
// ---------------------------------------------------------------------------------------------

/** Pad a ply to the contract's four slots. */
export function encodePly(ply: Ply): EncodedPly {
  if (ply.length > PLY_SLOTS) throw new Error(`a ply has at most ${PLY_SLOTS} sub-moves`);
  const moves = ply.map((m) => ({ point: m.point, die: m.die }));
  while (moves.length < PLY_SLOTS) moves.push({ point: 0, die: 0 });
  return { moves, count: ply.length };
}

export function decodePly(enc: EncodedPly): Ply {
  return enc.moves.slice(0, enc.count).map((m) => ({ point: m.point, die: m.die }));
}

/**
 * Apply a ply exactly as the contract's `applyPlyStrict` does: the dice used are the dice
 * rolled, each checker is legal when it moves, and a die left unplayed must be unplayable on
 * the final board. Throws `IllegalPlyError` where the circuit would refuse the transaction.
 *
 * `dice` is the roll as the chain stores it, `[a, b]`; doubles when `a === b`.
 */
export function applyPly(
  mine: Side,
  opp: Side,
  dice: readonly [number, number],
  ply: Ply,
): { mine: Side; opp: Side; won: boolean } {
  const [a, b] = dice;
  if (!(a >= 1 && a <= 6 && b >= 1 && b <= 6))
    throw new IllegalPlyError('the dice are not both 1..6');
  if (ply.length > PLY_SLOTS) throw new IllegalPlyError('at most four checkers move in one ply');
  const doubles = a === b;
  if (!doubles && ply.length > 2) {
    throw new IllegalPlyError('without doubles a ply plays at most two dice');
  }
  if (ply.length >= 1 && ply[0].die !== a && ply[0].die !== b) {
    throw new IllegalPlyError('a sub-move uses a die that was not rolled');
  }
  if (doubles && ply.some((m) => m.die !== a)) {
    throw new IllegalPlyError('doubles move every checker by the same die');
  }
  if (!doubles && ply.length === 2) {
    const ok = (ply[0].die === a && ply[1].die === b) || (ply[0].die === b && ply[1].die === a);
    if (!ok) throw new IllegalPlyError('the two sub-moves must use the two dice once each');
  }
  let m = mine;
  let o = opp;
  for (const sm of ply) {
    ({ mine: m, opp: o } = applySubMove(m, o, sm));
  }
  // The cheap half of maximality: whatever die is left must be unplayable now.
  const left: number[] = [];
  if (doubles) {
    if (ply.length < 4) left.push(a);
  } else if (ply.length === 0) {
    left.push(a, b);
  } else if (ply.length === 1) {
    left.push(ply[0].die === a ? b : a);
  }
  for (const die of left) {
    if (canPlayDie(m, o, die)) {
      throw new IllegalPlyError('a die is left unplayed that could still be played');
    }
  }
  return { mine: m, opp: o, won: hasWon(m) };
}

// ---------------------------------------------------------------------------------------------
// A ply, as the rules of the game require it
// ---------------------------------------------------------------------------------------------

/**
 * Every sequence of sub-moves playable with these dice, by depth-first search. Doubles are
 * searched in non-increasing order of starting point, which loses no position: moving the
 * higher checker first never makes a later move illegal (the bar is highest, outside checkers
 * come in before bearing off, and a higher point empties before a larger die bears off below it).
 */
function allSequences(mine: Side, opp: Side, dice: readonly [number, number]): Ply[] {
  const [a, b] = dice;
  const out: Ply[] = [];
  const walk = (m: Side, o: Side, remaining: number[], ceiling: number, prefix: Ply) => {
    out.push(prefix);
    if (remaining.length === 0) return;
    const tried = new Set<number>();
    for (let i = 0; i < remaining.length; i++) {
      const die = remaining[i];
      if (tried.has(die)) continue;
      tried.add(die);
      const rest = remaining.slice(0, i).concat(remaining.slice(i + 1));
      const top = a === b ? ceiling : BAR;
      for (let p = top; p >= 1; p--) {
        if (m[p] === 0 || subMoveViolation(m, o, p, die) !== null) continue;
        const next = applySubMove(m, o, { point: p, die });
        walk(next.mine, next.opp, rest, p, [...prefix, { point: p, die }]);
      }
    }
  };
  walk(mine, opp, a === b ? [a, a, a, a] : [a, b], BAR, []);
  return out;
}

/**
 * The plies the rules allow: as many dice as can be played, and -- when only one of two
 * different dice can be played -- the larger one if it can be. A pass (`[]`) only when nothing
 * can move. Never empty.
 */
export function legalPlies(mine: Side, opp: Side, dice: readonly [number, number]): Ply[] {
  checkSide(mine, 'legalPlies');
  checkSide(opp, 'legalPlies');
  const all = allSequences(mine, opp, dice);
  const most = Math.max(...all.map((p) => p.length));
  let best = all.filter((p) => p.length === most);
  const [a, b] = dice;
  if (a !== b && most === 1) {
    const larger = Math.max(a, b);
    if (best.some((p) => p[0].die === larger)) best = best.filter((p) => p[0].die === larger);
  }
  return best;
}

/** The board a ply leads to, as a string key -- two plies are the same move iff their keys match. */
export function positionKey(mine: Side, opp: Side): string {
  return `${mine.join(',')}|${opp.join(',')}`;
}

/**
 * The distinct positions the legal plies reach, each with one representative ply -- what a
 * move picker should enumerate (many orders of the same checkers reach the same position).
 */
export function legalPositions(
  mine: Side,
  opp: Side,
  dice: readonly [number, number],
): { ply: Ply; mine: Side; opp: Side }[] {
  const seen = new Map<string, { ply: Ply; mine: Side; opp: Side }>();
  for (const ply of legalPlies(mine, opp, dice)) {
    const r = applyPly(mine, opp, dice, ply);
    const key = positionKey(r.mine, r.opp);
    if (!seen.has(key)) seen.set(key, { ply, mine: r.mine, opp: r.opp });
  }
  return [...seen.values()];
}

/**
 * Why a ply breaks the rules of the game, or `null` if it is legal. Reports the two rules the
 * chain does not enforce as well as the ones it does, so the verifier can say which a ply broke.
 */
export function plyRuleViolation(
  mine: Side,
  opp: Side,
  dice: readonly [number, number],
  ply: Ply,
): string | null {
  let result: { mine: Side; opp: Side };
  try {
    result = applyPly(mine, opp, dice, ply);
  } catch (e) {
    if (e instanceof IllegalPlyError) return e.message;
    throw e;
  }
  const key = positionKey(result.mine, result.opp);
  const legal = legalPositions(mine, opp, dice);
  if (legal.some((l) => positionKey(l.mine, l.opp) === key)) return null;
  const most = legalPlies(mine, opp, dice)[0].length;
  if (ply.length < most) {
    return `played ${ply.length} ${ply.length === 1 ? 'die' : 'dice'} where ${most} could be played`;
  }
  return 'played the smaller die where the larger could be played';
}
