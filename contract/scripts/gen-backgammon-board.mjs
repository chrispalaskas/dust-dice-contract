#!/usr/bin/env node
// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates contract/src/backgammon-board.compact -- the board logic of the Backgammon table.
 *
 * WHY GENERATED. A `Vector` index must be a compile-time constant, so every "the count on the
 * point this checker came from" is a 25-way sum of `[from == p] * count[p]`, and a four-checker
 * ply needs a few hundred of them. Written by hand that is thousands of lines nobody can review;
 * generated, the rule is stated once, in this file, in the functions below.
 *
 * WHY DELTA FORM (and the one thing a reader of the output must know). The obvious shape --
 * apply sub-move 0 to the board, then apply sub-move 1 to the result, and so on -- chains four
 * boards, and compactc expands a `const` at every use site instead of sharing it
 * (docs/bugs-found.md #1): each board would carry the whole expression of the one before it,
 * and a checker's count would be re-expanded once per read. The compile does not finish.
 *
 * So no intermediate board is ever built. Every read at sub-move j is the LEDGER value plus the
 * effect of the earlier sub-moves, written out from scratch:
 *
 *     mine_j[p] = mine[p] + #{k < j : checker k landed on p} - #{k < j : checker k left p}
 *
 * which is a flat sum of small comparisons whatever j is. It is exact because during your own
 * turn the opponent's checkers only ever LEAVE points (to the bar) -- so "is this point
 * blocked?" can read the opponent's side as it was at the start of the ply -- and your own
 * checkers are never hit.
 *
 * WHY FIELD ARITHMETIC. The counts are summed as `Field` so that a delta can never underflow a
 * `Uint` on a path that is evaluated but not taken (a circuit has no branches). Only equalities
 * are asked of them (`== 0`, `!= 0`, `== 1`), and those are sound: by induction over the
 * sub-moves, every earlier assert holding means every count is a real, non-negative count, so
 * "not zero" means "at least one". An illegal ply fails an assert; it never reaches a cast.
 *
 * Board layout, each side from ITS OWN point of view: index 0 = borne off, 1..24 = points
 * (home is 1..6, a checker moves from p to p - die), 25 = the bar. My point p is the
 * opponent's index 25 - p. A target is carried SHIFTED by six, `tt = from + 6 - die`, so that
 * bearing off (tt <= 6) never needs a subtraction that could go below zero.
 *
 * Run: `node contract/scripts/gen-backgammon-board.mjs` (writes the file). `npm run
 * compact:backgammon` does not run it -- the output is committed, so a reviewer diffs the
 * Compact, not the generator.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'backgammon-board.compact',
);

const SLOTS = [0, 1, 2, 3];
const POINTS = range(1, 24); // real points
const FROMS = range(1, 25); // points a checker may leave: 1..24 and the bar
const BAR = 25;

function range(lo, hi) {
  const out = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

const sum = (terms) => (terms.length === 0 ? '0' : terms.join(' + '));
const or = (terms) => (terms.length === 0 ? 'false' : terms.join(' || '));

// Names of the per-slot predicates, so the emitted code reads like the rule.
const act = (k) => `act${k}`; // slot k is played
const eF = (k, p) => `lf${k}_${p}`; // checker k Leaves point p
const eT = (k, p) => `lt${k}_${p}`; // checker k lands on point p
const off = (k) => `off${k}`; // checker k is borne off
const m = (j, p) => `m${j}_${p}`; // my count at p before sub-move j (j = 4: after the ply)
const o4 = (q) => `o4_${q}`; // opponent's count at q after the ply

/** My count at `p` before sub-move `j`, from the ledger value and the earlier sub-moves. */
function mineBefore(j, p) {
  let e = `(mine[${p}] as Field)`;
  for (let k = 0; k < j; k++) {
    if (p === 0) e += ` + bf(${off(k)})`;
    else {
      if (p <= 24) e += ` + bf(${eT(k, p)})`;
      e += ` - bf(${eF(k, p)})`;
    }
  }
  return e;
}

function emitApply(strict) {
  const L = [];
  const name = strict ? 'applyPlyStrict' : 'applyPly';
  L.push(`export pure circuit ${name}(`);
  L.push('                mine: Vector<26, Uint<8>>,');
  L.push('                opp: Vector<26, Uint<8>>,');
  L.push('                a: Uint<8>,');
  L.push('                b: Uint<8>,');
  L.push('                ply: Vector<4, SubMove>,');
  L.push('                count: Uint<8>,');
  L.push('                ): PlyOutcome {');
  L.push('  assert(a >= 1 && a <= 6 && b >= 1 && b <= 6, "ply: the dice are not both 1..6");');
  L.push('  assert(count <= 4, "ply: at most four checkers move in one ply");');
  L.push('  const dbl = a == b;');
  L.push('  assert(dbl || count <= 2, "ply: without doubles a ply plays at most two dice");');
  for (const k of SLOTS) L.push(`  const ${act(k)} = count >= ${k + 1};`);
  for (const k of SLOTS) {
    L.push(`  const f${k} = ply[${k}].point;`);
    L.push(`  const d${k} = ply[${k}].die;`);
  }
  L.push('');
  L.push('  // ---- the argument encoding: played slots first, unused slots exactly {0, 0} ----');
  for (const k of SLOTS) {
    L.push(
      `  assert(${act(k)} || (f${k} == 0 && d${k} == 0), "ply: sub-move ${k} is unused and must be {point: 0, die: 0}");`,
    );
    L.push(
      `  assert(!${act(k)} || (f${k} >= 1 && f${k} <= 25), "ply: sub-move ${k} starts off the board");`,
    );
  }
  L.push('');
  L.push(
    '  // ---- each die as rolled: doubles give four of one value, otherwise each die once ----',
  );
  L.push(
    '  assert(!act0 || d0 == a || d0 == b, "ply: sub-move 0 uses a die that was not rolled");',
  );
  L.push(
    '  assert(!dbl || ((!act1 || d1 == a) && (!act2 || d2 == a) && (!act3 || d3 == a)), "ply: doubles move every checker by the same die");',
  );
  L.push(
    '  assert(dbl || !act1 || (d0 == a && d1 == b) || (d0 == b && d1 == a), "ply: the two sub-moves must use the two dice once each");',
  );
  L.push('');
  L.push('  // ---- targets, shifted by six: tt <= 6 bears off, tt == 6 exactly ----');
  for (const k of SLOTS) L.push(`  const tt${k} = (f${k} + 6 - d${k}) as Uint<8>;`);
  L.push('');
  L.push('  // ---- which point each played checker leaves and lands on ----');
  for (const k of SLOTS) {
    for (const p of FROMS) L.push(`  const ${eF(k, p)} = ${act(k)} && f${k} == ${p};`);
    for (const p of POINTS) L.push(`  const ${eT(k, p)} = ${act(k)} && tt${k} == ${p + 6};`);
    L.push(`  const ${off(k)} = ${act(k)} && tt${k} <= 6;`);
  }
  L.push('');
  L.push('  // ---- my board before each sub-move, and after the ply (j = 4) ----');
  for (let j = 1; j <= 4; j++) {
    for (let p = 0; p <= 25; p++) L.push(`  const ${m(j, p)} = ${mineBefore(j, p)};`);
  }
  const mj = (j, p) => (j === 0 ? `(mine[${p}] as Field)` : m(j, p));
  L.push('');
  L.push(
    '  // ---- the legality of each sub-move, against the board as it stands at that point ----',
  );
  for (const k of SLOTS) {
    L.push(`  // sub-move ${k}`);
    L.push(`  const own${k} = ${sum(FROMS.map((p) => `bf(${eF(k, p)}) * ${mj(k, p)}`))};`);
    L.push(
      `  assert(!${act(k)} || own${k} != 0, "ply: sub-move ${k} moves a checker you do not have on that point");`,
    );
    L.push(
      `  assert(!${act(k)} || ${mj(k, BAR)} == 0 || f${k} == 25, "ply: sub-move ${k} -- a checker on the bar must enter first");`,
    );
    L.push(
      `  const oppAt${k} = ${sum(POINTS.map((p) => `bf(${eT(k, p)}) * (opp[${25 - p}] as Field)`))};`,
    );
    L.push(`  const land${k} = ${act(k)} && tt${k} >= 7;`);
    L.push(
      `  assert(!land${k} || oppAt${k} == 0 || oppAt${k} == 1, "ply: sub-move ${k} lands on a point the opponent holds");`,
    );
    L.push(`  const outside${k} = ${sum(range(7, 25).map((p) => mj(k, p)))};`);
    L.push(
      `  assert(!${off(k)} || outside${k} == 0, "ply: sub-move ${k} bears off while a checker is outside the home board");`,
    );
    L.push(`  const over${k} = ${off(k)} && tt${k} < 6;`);
    L.push(
      `  const higher${k} = ${sum(range(2, 6).map((p) => `bf(f${k} < ${p}) * ${mj(k, p)}`))};`,
    );
    L.push(
      `  assert(!over${k} || higher${k} == 0, "ply: sub-move ${k} bears off with a larger die while a checker sits on a higher point");`,
    );
  }
  L.push('');
  L.push(
    '  // ---- the opponent after the ply: a blot on a point I landed on goes to the bar ----',
  );
  for (const q of POINTS) {
    const t = 25 - q;
    L.push(`  const hit${q} = opp[${q}] == 1 && (${or(SLOTS.map((k) => eT(k, t)))});`);
  }
  for (let q = 0; q <= 25; q++) {
    let e;
    if (q === 0) e = `(opp[0] as Field)`;
    else if (q === 25) e = `(opp[25] as Field) + ${sum(POINTS.map((p) => `bf(hit${p})`))}`;
    else e = `(opp[${q}] as Field) - bf(hit${q})`;
    L.push(`  const ${o4(q)} = ${e};`);
  }
  if (strict) {
    L.push('');
    L.push('  // ---- the cheap half of "play as many dice as you can" ----');
    L.push('  //');
    L.push(
      '  // A ply that leaves a die unplayed must leave it UNPLAYABLE on the final board. This never',
    );
    L.push(
      '  // rejects a legal ply (if the die could still be played, more dice could have been), and it',
    );
    L.push(
      '  // closes "just pass". It is NOT the whole rule -- a different ORDER might have let both',
    );
    L.push(
      '  // dice play, and the larger-die rule is not checked -- the client and the verifier do those.',
    );
    L.push(`  const outside4 = ${sum(range(7, 25).map((p) => m(4, p)))};`);
    for (let v = 1; v <= 6; v++) {
      const moves = [];
      for (const p of FROMS) {
        const t = p - v;
        let land;
        if (t >= 1) land = `(${o4(25 - t)} == 0 || ${o4(25 - t)} == 1)`;
        else if (t === 0) land = 'outside4 == 0';
        else {
          const hi = range(p + 1, 6).map((q) => m(4, q));
          land = hi.length === 0 ? 'outside4 == 0' : `(outside4 == 0 && ${sum(hi)} == 0)`;
        }
        const barOk = p === BAR ? '' : ` && ${m(4, BAR)} == 0`;
        moves.push(`(${m(4, p)} != 0${barOk} && ${land})`);
      }
      L.push(`  const can${v} = ${or(moves)};`);
    }
    L.push(
      '  const canA = (a == 1 && can1) || (a == 2 && can2) || (a == 3 && can3) || (a == 4 && can4) || (a == 5 && can5) || (a == 6 && can6);',
    );
    L.push(
      '  const canB = (b == 1 && can1) || (b == 2 && can2) || (b == 3 && can3) || (b == 4 && can4) || (b == 5 && can5) || (b == 6 && can6);',
    );
    L.push(
      '  // Non-doubles: nothing played -> neither die may be playable; one played -> not the other.',
    );
    L.push('  const leftA = !dbl && (count == 0 || (count == 1 && d0 == b));');
    L.push('  const leftB = !dbl && (count == 0 || (count == 1 && d0 == a));');
    L.push('  assert(!leftA || !canA, "ply: a die is left unplayed that could still be played");');
    L.push('  assert(!leftB || !canB, "ply: a die is left unplayed that could still be played");');
    L.push(
      '  assert(!dbl || count == 4 || !canA, "ply: a die is left unplayed that could still be played");',
    );
  }
  L.push('');
  L.push(
    `  return PlyOutcome { mine: [${range(0, 25)
      .map((p) => `${m(4, p)} as Uint<8>`)
      .join(', ')}],`,
  );
  L.push(
    `                      opp: [${range(0, 25)
      .map((q) => `${o4(q)} as Uint<8>`)
      .join(', ')}],`,
  );
  L.push(`                      won: ${m(4, 0)} == 15, };`);
  L.push('}');
  return L.join('\n');
}

const header = `// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0
//
// GENERATED by contract/scripts/gen-backgammon-board.mjs -- do not edit by hand; edit the
// generator and re-run it. The generator's header explains the shape (delta form, Field counts,
// the board layout); read it before reading this.
//
// \`include\`d by backgammon.compact, so this file carries NO pragma and NO import of its own.
// Editing it changes the verifier keys of the Backgammon table.
//
// Board layout, each side from ITS OWN point of view: index 0 = borne off, 1..24 = points
// (home is 1..6; a checker moves from p to p - die), 25 = the bar. My point p is the opponent's
// index 25 - p.

/** One checker moved: from a point (1..24) or the bar (25), by one die. \`{0, 0}\` = unused. */
export struct SubMove {
  point: Uint<8>,
  die: Uint<8>,
}

/** A ply: up to four sub-moves, in the order they are played, and how many are real. */
export struct Ply {
  moves: Vector<4, SubMove>,
  count: Uint<8>,
}

/** Both sides after a ply, and whether the mover has just borne off its fifteenth checker. */
export struct PlyOutcome {
  mine: Vector<26, Uint<8>>,
  opp: Vector<26, Uint<8>>,
  won: Boolean,
}

/** \`Boolean\` as a 0/1 \`Field\`, for the counting sums. */
pure circuit bf(x: Boolean): Field {
  return (x as Uint<1>) as Field;
}

/** One side at the start: two on 24, five on 13, three on 8, five on 6. */
export pure circuit bgInitialSide(): Vector<26, Uint<8>> {
  return [${range(0, 25)
    .map((p) => ({ 24: 2, 13: 5, 8: 3, 6: 5 })[p] ?? 0)
    .join(', ')}];
}

/**
 * Apply one ply for the side to move, checking every sub-move against the board as it stands
 * when that checker moves: a checker must be there, the bar enters first, the landing point
 * must not hold two or more of the opponent's, bearing off needs every checker home, and a die
 * larger than the point bears off only from the highest occupied point. A single blot on the
 * landing point is hit to the bar.
 *
 * Does NOT enforce that the ply plays as many dice as possible, nor the larger-die rule -- see
 * \`applyPlyStrict\` for the half of that which is cheap, and the verifier for the rest.
 */
`;

const strictDoc = `
/**
 * \`applyPly\`, plus: a die the ply leaves unplayed must be unplayable on the final board.
 */
`;

const out = `${header}${emitApply(false)}\n${strictDoc}${emitApply(true)}\n`;
fs.writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${out.split('\n').length} lines)`);
