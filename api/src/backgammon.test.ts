// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  BAR,
  CHECKERS,
  IllegalPlyError,
  OFF,
  applyPly,
  applySubMove,
  canPlayDie,
  decodePly,
  encodePly,
  initialSide,
  legalPlies,
  legalPositions,
  pipCount,
  plyRuleViolation,
  type Ply,
  type Side,
} from './backgammon.js';

/** A side from `{point: count}`, the remainder borne off so it always holds fifteen. */
function side(points: Record<number, number>): Side {
  const s = new Array<number>(26).fill(0);
  let n = 0;
  for (const [p, c] of Object.entries(points)) {
    s[Number(p)] = c;
    n += c;
  }
  s[OFF] = CHECKERS - n;
  return s;
}

describe('positions', () => {
  it('starts with 167 pips a side and fifteen checkers', () => {
    const s = initialSide();
    expect(s.reduce((a, b) => a + b, 0)).toBe(CHECKERS);
    expect(pipCount(s)).toBe(167);
  });
});

describe('one checker', () => {
  it('moves, and hits a blot to the bar', () => {
    const mine = side({ 8: 1 });
    const opp = side({ 20: 1 }); // opponent's 20 is my 5
    const r = applySubMove(mine, opp, { point: 8, die: 3 });
    expect(r.hit).toBe(true);
    expect(r.mine[5]).toBe(1);
    expect(r.opp[20]).toBe(0);
    expect(r.opp[BAR]).toBe(1);
  });

  it('cannot land on a point the opponent holds', () => {
    const mine = side({ 8: 1 });
    const opp = side({ 20: 2 });
    expect(() => applySubMove(mine, opp, { point: 8, die: 3 })).toThrow(/holds the landing point/);
  });

  it('enters from the bar before anything else', () => {
    const mine = side({ [BAR]: 1, 8: 1 });
    const opp = side({});
    expect(() => applySubMove(mine, opp, { point: 8, die: 3 })).toThrow(/bar must enter first/);
    const r = applySubMove(mine, opp, { point: BAR, die: 3 });
    expect(r.mine[22]).toBe(1);
  });

  it('bears off only when every checker is home, and a larger die only from the highest', () => {
    expect(() => applySubMove(side({ 3: 1, 7: 1 }), side({}), { point: 3, die: 3 })).toThrow(
      /outside the home board/,
    );
    expect(applySubMove(side({ 3: 1 }), side({}), { point: 3, die: 3 }).mine[OFF]).toBe(CHECKERS);
    expect(() => applySubMove(side({ 3: 1, 5: 1 }), side({}), { point: 3, die: 6 })).toThrow(
      /highest point/,
    );
    expect(applySubMove(side({ 3: 1, 5: 1 }), side({}), { point: 5, die: 6 }).mine[5]).toBe(0);
  });
});

describe('a ply as the chain checks it', () => {
  it('plays the two dice once each, in either order', () => {
    const r = applyPly(
      initialSide(),
      initialSide(),
      [3, 1],
      [
        { point: 8, die: 3 },
        { point: 6, die: 1 },
      ],
    );
    expect(r.mine[5]).toBe(2);
    expect(() =>
      applyPly(
        initialSide(),
        initialSide(),
        [3, 1],
        [
          { point: 8, die: 3 },
          { point: 6, die: 3 },
        ],
      ),
    ).toThrow(/two dice once each/);
  });

  it('plays four of a kind on doubles', () => {
    const r = applyPly(
      initialSide(),
      initialSide(),
      [2, 2],
      [
        { point: 13, die: 2 },
        { point: 13, die: 2 },
        { point: 6, die: 2 },
        { point: 6, die: 2 },
      ],
    );
    expect(r.mine[11]).toBe(2);
    expect(r.mine[4]).toBe(2);
  });

  it('refuses a pass while a die can still be played', () => {
    expect(() => applyPly(initialSide(), initialSide(), [3, 1], [])).toThrow(IllegalPlyError);
  });

  it('accepts a pass when nothing can enter', () => {
    const mine = side({ [BAR]: 1, 6: 14 });
    const opp = side({ 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2 }); // a closed board
    expect(canPlayDie(mine, opp, 3)).toBe(false);
    expect(applyPly(mine, opp, [3, 5], []).mine).toEqual(mine);
  });

  it('round-trips the contract encoding', () => {
    const ply: Ply = [{ point: 13, die: 5 }];
    const enc = encodePly(ply);
    expect(enc.moves).toHaveLength(4);
    expect(enc.moves[1]).toEqual({ point: 0, die: 0 });
    expect(decodePly(enc)).toEqual(ply);
  });
});

describe('a ply as the rules require it', () => {
  it('offers the standard openings', () => {
    const plies = legalPositions(initialSide(), initialSide(), [3, 1]);
    // 8/5 6/5, the textbook 31, is among them
    expect(plies.some((p) => p.mine[5] === 2 && p.mine[8] === 2 && p.mine[6] === 4)).toBe(true);
    for (const p of legalPlies(initialSide(), initialSide(), [3, 1])) expect(p).toHaveLength(2);
  });

  it('plays both dice through a square the first die opens', () => {
    // One checker on my 7, fourteen off. The opponent holds my 1 (their 24).
    // 7-6 = 1 is blocked, but 7-1 = 6 brings it home and 6-6 bears it off: both dice play.
    const mine = side({ 7: 1 });
    const opp = side({ 24: 2 });
    expect(legalPlies(mine, opp, [6, 1])).toEqual([
      [
        { point: 7, die: 1 },
        { point: 6, die: 6 },
      ],
    ]);
  });

  it('passes when neither die can be played', () => {
    // Also holding my 6 (their 19): 7-1 and 7-6 are both blocked.
    expect(legalPlies(side({ 7: 1 }), side({ 24: 2, 19: 2 }), [6, 1])).toEqual([[]]);
  });

  it('plays the larger die when only one of the two can be played', () => {
    // One checker on my 13; the opponent holds my 2 (their 23), the square both dice reach.
    // 13-6 = 7 then 7-5 = 2 is blocked; 13-5 = 8 then 8-6 = 2 is blocked. Either die alone
    // plays, and the rule says the 6.
    const mine = side({ 13: 1 });
    const opp = side({ 23: 2 });
    expect(legalPlies(mine, opp, [6, 5])).toEqual([[{ point: 13, die: 6 }]]);
    expect(plyRuleViolation(mine, opp, [6, 5], [{ point: 13, die: 6 }])).toBeNull();

    // The chain cannot see this: after 13-5 = 8 the 6 is unplayable, so it accepts the 5 alone.
    expect(() => applyPly(mine, opp, [6, 5], [{ point: 13, die: 5 }])).not.toThrow();
    expect(plyRuleViolation(mine, opp, [6, 5], [{ point: 13, die: 5 }])).toMatch(
      /smaller die where the larger could be played/,
    );
  });

  it('refuses, on chain, a single die that leaves the other playable', () => {
    // Two checkers, 13 and 9; the opponent holds my 7 (their 18) and my 4 (their 21).
    // 9-6 = 3 plays, and afterwards 13-5 = 8 still plays -- so 9-6 alone is refused.
    const mine = side({ 13: 1, 9: 1 });
    const opp = side({ 18: 2, 21: 2 });
    expect(() => applyPly(mine, opp, [6, 5], [{ point: 9, die: 6 }])).toThrow(/left unplayed/);
    expect(plyRuleViolation(mine, opp, [6, 5], [{ point: 9, die: 6 }])).toMatch(/left unplayed/);
    for (const p of legalPlies(mine, opp, [6, 5])) expect(p).toHaveLength(2);
  });
});

describe('random games', () => {
  function rng(seed: number) {
    let x = seed >>> 0;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 2 ** 32;
    };
  }

  it('always end, never lose a checker, and every offered ply is chain-legal', () => {
    for (let g = 0; g < 30; g++) {
      const r = rng(1000 + g);
      const die = () => 1 + Math.floor(r() * 6);
      let sides = [initialSide(), initialSide()];
      let mover = 0;
      let plies = 0;
      for (;;) {
        const dice: [number, number] = [die(), die()];
        const options = legalPlies(sides[mover], sides[1 - mover], dice);
        const ply = options[Math.floor(r() * options.length)];
        const out = applyPly(sides[mover], sides[1 - mover], dice, ply);
        expect(plyRuleViolation(sides[mover], sides[1 - mover], dice, ply)).toBeNull();
        sides = mover === 0 ? [out.mine, out.opp] : [out.opp, out.mine];
        for (const s of sides) expect(s.reduce((a, b) => a + b, 0)).toBe(CHECKERS);
        plies++;
        if (out.won) break;
        mover = 1 - mover;
        expect(plies).toBeLessThan(3000);
      }
    }
  });
});
