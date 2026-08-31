// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-check of the scoring circuits against the contract-canonical rules engine.
 *
 * api/src/rules.ts is the reference. Every number the circuit produces is compared against
 * it, and where the reference throws `RuleViolation` the circuit must report
 * `validPlacement: false`. The comparison is not decorative: `applyScore`'s joker rules have
 * three branches with different scoring, the circuit computes all three unconditionally and
 * selects, and a wrong selector is invisible by inspection. Only differential testing over a
 * corpus finds it.
 *
 * The corpus is deliberately shaped, not merely large. Uniform random dice are a Yahtzee
 * 6/7776 of the time, so a plain random corpus would exercise the joker branches roughly
 * never; two fifths of the cases here are five-of-a-kind with the Yahtzee box already taken,
 * which is the only way into them.
 *
 * Inputs derive from a fixed seed rather than the system RNG, matching fairness.test.ts: a
 * differential test that fails one run in twenty gets ignored, and a failure has to be
 * reproducible on the machine that has to fix it.
 *
 * Run: npm test -w @yahtzee/contract
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  applyScore as refApplyScore,
  CATEGORY_COUNT,
  Category,
  type Dice as RefDice,
  emptyScorecard as refEmptyScorecard,
  grandTotal as refGrandTotal,
  isYahtzee as refIsYahtzee,
  rawScore as refRawScore,
  RuleViolation,
  type Scorecard as RefScorecard,
  splitPot as refSplitPot,
  upperTotal as refUpperTotal,
  UPPER_BONUS,
  winnerSeat as refWinnerSeat,
  YAHTZEE_BONUS,
  // Relative, not '@yahtzee/api/src/rules.ts'. That specifier does not resolve: api's
  // package.json declares an `exports` map with only '.' and './node', so Node rejects the
  // subpath outright (ERR_PACKAGE_PATH_NOT_EXPORTED) and this whole file fails to load --
  // taking its tests with it, silently, because a load failure counts as one failing file
  // rather than 35 failing tests. The exports map is deliberate (it keeps wallet plumbing out
  // of browser bundles), so the right long-term fix is a './rules' subpath export in
  // api/package.json pointing at the built rules module; until that exists, reaching for the
  // source directly is what actually runs.
} from '../../../api/src/rules.ts';
import { pureCircuits as scoringPure, type Scorecard } from '../managed/scoring/contract/index.js';
import { pureCircuits as takeTurnPure } from '../managed/takeTurn/contract/index.js';
import { HoldPolicy, resolveTurnTs, type HoldPolicyValue } from '../dice-mirror.ts';
import { createDicePrivateState } from '../witnesses.ts';
import { ScoringSimulator, TakeTurnSimulator, diceToArray } from './simulator.ts';

// ---------------------------------------------------------------------------------------
// Corpus size
// ---------------------------------------------------------------------------------------

/**
 * Randomised (dice, scorecard) pairs. Each is scored into all 13 categories, so the
 * `applyScore` comparison count is 13x this.
 */
const CASES = 2_500;

/** Two fifths of the corpus is a joker situation; see the file header. */
const JOKER_SHARE = 0.4;

// ---------------------------------------------------------------------------------------
// Deterministic byte stream
// ---------------------------------------------------------------------------------------

/** sha256(label:i) chained into an endless byte stream. Same idea as fairness.test.ts. */
function makeRng(label: string): () => number {
  let block = new Uint8Array(0);
  let blockIndex = 0;
  let pos = 0;
  return () => {
    if (pos >= block.length) {
      block = new Uint8Array(createHash('sha256').update(`${label}:${blockIndex++}`).digest());
      pos = 0;
    }
    return block[pos++]!;
  };
}

/** Uniform-enough integer in [0, n). The residual modulo bias is irrelevant to a corpus. */
const below = (rng: () => number, n: number): number => rng() % n;

// ---------------------------------------------------------------------------------------
// Bridging the two representations
// ---------------------------------------------------------------------------------------

const toRefDice = (d: readonly number[]): RefDice => d as unknown as RefDice;
const toCircuitDice = (d: readonly number[]): bigint[] => d.map(BigInt);

/**
 * A circuit `Scorecard` from a reference one.
 *
 * The reference uses `number | null` per category; the circuit splits that into a score plus
 * a `filled` flag, because a circuit has no null. `null` becomes `(0, false)` and a scored 0
 * becomes `(0, true)` -- keeping exactly the distinction the reference draws.
 */
function toCircuitCard(card: RefScorecard): Scorecard {
  return {
    scores: card.scores.map((s) => BigInt(s ?? 0)),
    filled: card.scores.map((s) => s !== null),
    yahtzeeBonuses: BigInt(card.yahtzeeBonuses),
  };
}

/** The reverse, so a circuit-produced card can be fed back to the reference. */
function toRefCard(card: Scorecard): RefScorecard {
  return {
    scores: card.scores.map((s, i) => (card.filled[i] ? Number(s) : null)),
    yahtzeeBonuses: Number(card.yahtzeeBonuses),
  };
}

const cardsEqual = (a: Scorecard, b: Scorecard): boolean =>
  a.yahtzeeBonuses === b.yahtzeeBonuses &&
  a.scores.every((s, i) => s === b.scores[i]) &&
  a.filled.every((f, i) => f === b.filled[i]);

/** All 6^5 = 7 776 dice hands, in order. */
function allHands(): number[][] {
  const out: number[][] = [];
  for (let a = 1; a <= 6; a++)
    for (let b = 1; b <= 6; b++)
      for (let c = 1; c <= 6; c++)
        for (let d = 1; d <= 6; d++) for (let e = 1; e <= 6; e++) out.push([a, b, c, d, e]);
  return out;
}

// ---------------------------------------------------------------------------------------
// Corpus generation
// ---------------------------------------------------------------------------------------

type Case = { dice: number[]; card: RefScorecard };

/**
 * One corpus case.
 *
 * A filled category is given the reference's own score for some random hand rather than an
 * arbitrary number, so upper totals land near the 63 bonus threshold as often as a real game
 * puts them there. The Yahtzee box is special-cased to 0 or 50 -- those are its only real
 * values, and which one it holds decides whether the +100 is paid.
 */
function makeCase(rng: () => number, joker: boolean): Case {
  const dice = joker
    ? Array(5).fill(1 + below(rng, 6))
    : Array.from({ length: 5 }, () => 1 + below(rng, 6));

  const scores: (number | null)[] = Array(CATEGORY_COUNT).fill(null);
  for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
    const fillProbability = cat === Category.Yahtzee && joker ? 256 : 110; // /256
    if (rng() >= fillProbability) continue;
    if (cat === Category.Yahtzee) {
      scores[cat] = below(rng, 2) === 0 ? 0 : 50;
    } else {
      const hand = Array.from({ length: 5 }, () => 1 + below(rng, 6));
      scores[cat] = refRawScore(cat as Category, toRefDice(hand));
    }
  }

  // A joker case needs the Yahtzee box taken, or it is not a joker case at all.
  if (joker && scores[Category.Yahtzee] === null) scores[Category.Yahtzee] = 50;

  return { dice, card: { scores, yahtzeeBonuses: below(rng, 3) } };
}

function makeCorpus(): Case[] {
  const rng = makeRng('yahtzee-scoring-corpus');
  return Array.from({ length: CASES }, (_, i) => makeCase(rng, i < CASES * JOKER_SHARE));
}

// ---------------------------------------------------------------------------------------
// rawScore, exhaustively
// ---------------------------------------------------------------------------------------

describe('rawScore matches api/src/rules.ts', () => {
  it('agrees on every one of the 13 x 7 776 = 101 088 (category, hand) pairs', () => {
    const hands = allHands();
    let checked = 0;
    for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
      for (const hand of hands) {
        const expected = refRawScore(cat as Category, toRefDice(hand));
        const actual = Number(scoringPure.rawScore(BigInt(cat), toCircuitDice(hand)));
        if (actual !== expected) {
          assert.fail(
            `rawScore(${Category[cat as Category]}, [${hand.join(',')}]): ` +
              `circuit ${actual}, rules.ts ${expected}`,
          );
        }
        checked++;
      }
    }
    assert.equal(checked, CATEGORY_COUNT * 7776);
  });

  it('is 0 for a category index outside 0..12, rather than aborting', () => {
    // No selector matches, so the sum is empty. `applyScore` rejects such a category via
    // `validPlacement`; `rawScore` on its own must not throw, or a probe circuit that scores
    // a garbage index would abort instead of returning a rejection.
    for (const cat of [13n, 14n, 100n, 255n]) {
      assert.equal(Number(scoringPure.rawScore(cat, toCircuitDice([1, 2, 3, 4, 5]))), 0);
    }
  });

  it('aborts rather than misscores when a die is outside 1..6', () => {
    // The documented precondition, made visible. `rules.ts` has no equivalent guard -- it
    // indexes its histogram by face and corrupts it silently -- so the circuit being the
    // stricter of the two is deliberate, and `scoreTurn` is where the check is paid for.
    assert.throws(() =>
      scoringPure.rawScore(BigInt(Category.Chance), toCircuitDice([255, 255, 255, 255, 255])),
    );
    // A single out-of-range die that keeps the pip total under 256 scores as if that die were
    // simply not any face: no abort, and the upper categories are unaffected.
    assert.equal(
      Number(scoringPure.rawScore(BigInt(Category.Ones), toCircuitDice([1, 1, 7, 7, 7]))),
      2,
    );
  });

  it('isYahtzee agrees on every hand', () => {
    for (const hand of allHands()) {
      assert.equal(
        scoringPure.isYahtzee(toCircuitDice(hand)),
        refIsYahtzee(toRefDice(hand)),
        `isYahtzee([${hand.join(',')}])`,
      );
    }
  });
});

// ---------------------------------------------------------------------------------------
// applyScore over the corpus
// ---------------------------------------------------------------------------------------

describe('applyScore matches api/src/rules.ts', () => {
  it(`agrees on ${CASES} scorecards x 13 categories, placement and score and bonus`, () => {
    const corpus = makeCorpus();
    let compared = 0;
    let legal = 0;
    let jokerBonuses = 0;

    for (const { dice, card } of corpus) {
      const circuitCard = toCircuitCard(card);
      for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
        const outcome = scoringPure.applyScore(
          BigInt(cat),
          toCircuitDice(dice),
          circuitCard.filled,
          circuitCard.scores[Category.Yahtzee]!,
        );

        let reference: RefScorecard | null = null;
        try {
          reference = refApplyScore(card, cat as Category, toRefDice(dice));
        } catch (e) {
          assert.ok(e instanceof RuleViolation, `unexpected error kind: ${String(e)}`);
        }

        const where =
          `category ${Category[cat as Category]}, dice [${dice.join(',')}], ` +
          `card ${JSON.stringify(card.scores)}`;

        assert.equal(
          outcome.validPlacement,
          reference !== null,
          `validPlacement disagrees at ${where}`,
        );

        if (reference !== null) {
          legal++;
          assert.equal(Number(outcome.score), reference.scores[cat], `score disagrees at ${where}`);
          const refBonus = reference.yahtzeeBonuses > card.yahtzeeBonuses;
          assert.equal(outcome.bonusEarned, refBonus, `bonusEarned disagrees at ${where}`);
          if (refBonus) jokerBonuses++;

          // placeScore must reproduce the reference's whole updated card, not just the score.
          const placed = scoringPure.placeScore(circuitCard, BigInt(cat), toCircuitDice(dice));
          assert.ok(
            cardsEqual(placed, toCircuitCard(reference)),
            `placeScore disagrees at ${where}: ${JSON.stringify(toRefCard(placed))} vs ` +
              `${JSON.stringify(reference.scores)}`,
          );

          // And the incremental total must equal both the reference's and the naive form's.
          assert.equal(
            Number(scoringPure.cardTotal(placed)),
            refGrandTotal(reference),
            `cardTotal disagrees at ${where}`,
          );
          assert.equal(
            Number(
              scoringPure.totalAfterPlacing(
                circuitCard,
                BigInt(cat),
                outcome.score,
                outcome.bonusEarned,
              ),
            ),
            refGrandTotal(reference),
            `totalAfterPlacing disagrees at ${where}`,
          );
        }
        compared++;
      }
    }

    assert.equal(compared, CASES * CATEGORY_COUNT);
    // Coverage guards: a corpus that never reaches a branch proves nothing about it.
    assert.ok(legal > CASES, `only ${legal} legal placements in ${compared} cases`);
    assert.ok(jokerBonuses > 200, `only ${jokerBonuses} joker bonuses; corpus lost its shape`);
  });

  it('reaches all three joker branches and the no-bonus scratched-box path', () => {
    // Explicit coverage accounting, so the corpus test above cannot pass vacuously if the
    // generator drifts.
    const corpus = makeCorpus();
    const seen = { forcedUpper: 0, lowerJoker: 0, upperFallback: 0, scratched: 0 };
    const lower = [
      Category.ThreeOfAKind,
      Category.FourOfAKind,
      Category.FullHouse,
      Category.SmallStraight,
      Category.LargeStraight,
      Category.Chance,
    ];

    for (const { dice, card } of corpus) {
      if (!refIsYahtzee(toRefDice(dice))) continue;
      if (card.scores[Category.Yahtzee] === null) continue;
      const upperCat = (dice[0]! - 1) as Category;
      if (card.scores[upperCat] === null) seen.forcedUpper++;
      else if (lower.some((c) => card.scores[c] === null)) seen.lowerJoker++;
      else seen.upperFallback++;
      if (card.scores[Category.Yahtzee] === 0) seen.scratched++;
    }

    assert.ok(seen.forcedUpper > 50, `forced-upper branch hit ${seen.forcedUpper} times`);
    assert.ok(seen.lowerJoker > 50, `lower-joker branch hit ${seen.lowerJoker} times`);
    assert.ok(seen.scratched > 50, `scratched-box path hit ${seen.scratched} times`);
    // The upper-fallback branch needs every lower box filled at once, which random cards
    // reach rarely; it has its own targeted test below rather than a corpus threshold.
  });
});

// ---------------------------------------------------------------------------------------
// Targeted joker scenarios, ported from api/src/rules.test.ts
// ---------------------------------------------------------------------------------------

describe('joker rules: the scenarios from api/src/rules.test.ts, run through the circuit', () => {
  const yahtzeeOf = (face: number) => [face, face, face, face, face];

  /** A card with the Yahtzee box scored 50 by a yahtzee of 3s. */
  const withYahtzeeScored = (): RefScorecard =>
    refApplyScore(refEmptyScorecard(), Category.Yahtzee, toRefDice(yahtzeeOf(3)));

  const outcomeOf = (card: RefScorecard, cat: Category, dice: number[]) => {
    const c = toCircuitCard(card);
    return scoringPure.applyScore(
      BigInt(cat),
      toCircuitDice(dice),
      c.filled,
      c.scores[Category.Yahtzee]!,
    );
  };

  it('extra yahtzee forces the open matching upper box and pays the bonus', () => {
    const card = withYahtzeeScored();
    // Chance is open, but the joker rules forbid it while Fours is open.
    const illegal = outcomeOf(card, Category.Chance, yahtzeeOf(4));
    assert.equal(illegal.validPlacement, false);

    const legal = outcomeOf(card, Category.Fours, yahtzeeOf(4));
    assert.equal(legal.validPlacement, true);
    assert.equal(Number(legal.score), 20);
    assert.equal(legal.bonusEarned, true);

    const placed = scoringPure.placeScore(
      toCircuitCard(card),
      BigInt(Category.Fours),
      toCircuitDice(yahtzeeOf(4)),
    );
    assert.equal(Number(scoringPure.cardTotal(placed)), 50 + 20 + YAHTZEE_BONUS);
  });

  it('joker full house and straights count in full when the upper box is filled', () => {
    let card = withYahtzeeScored();
    card = refApplyScore(card, Category.Fours, toRefDice([4, 4, 1, 2, 3])); // Fours = 8

    const fh = outcomeOf(card, Category.FullHouse, yahtzeeOf(4));
    assert.equal(fh.validPlacement, true);
    assert.equal(Number(fh.score), 25);
    assert.equal(fh.bonusEarned, true);

    const ls = outcomeOf(card, Category.LargeStraight, yahtzeeOf(4));
    assert.equal(ls.validPlacement, true);
    assert.equal(Number(ls.score), 40);

    const ss = outcomeOf(card, Category.SmallStraight, yahtzeeOf(4));
    assert.equal(Number(ss.score), 30);
  });

  it('scratched yahtzee box: joker placement rules apply but no bonus', () => {
    let card = refApplyScore(refEmptyScorecard(), Category.Yahtzee, toRefDice([1, 2, 3, 4, 5]));
    card = refApplyScore(card, Category.Fours, toRefDice([4, 4, 1, 2, 3]));
    const next = outcomeOf(card, Category.FullHouse, yahtzeeOf(4));
    assert.equal(next.validPlacement, true);
    assert.equal(Number(next.score), 25);
    assert.equal(next.bonusEarned, false);
  });

  it('upper fallback scores face value when every lower box is filled', () => {
    let card = withYahtzeeScored();
    card = refApplyScore(card, Category.Fives, toRefDice([5, 5, 1, 2, 3]));
    for (const cat of [
      Category.ThreeOfAKind,
      Category.FourOfAKind,
      Category.FullHouse,
      Category.SmallStraight,
      Category.LargeStraight,
      Category.Chance,
    ]) {
      card = refApplyScore(card, cat, toRefDice([1, 2, 3, 5, 6]));
    }
    const next = outcomeOf(card, Category.Twos, yahtzeeOf(5));
    assert.equal(next.validPlacement, true);
    assert.equal(Number(next.score), 0, 'no 2s in a yahtzee of 5s');
    assert.equal(next.bonusEarned, true, 'the bonus is still earned');
  });

  it('a filled category is rejected even when the joker rules would allow it', () => {
    // Fours is the forced box, and it is already taken: the ordinary "already filled" rule
    // wins, exactly as rules.ts throws before it looks at jokers.
    let card = withYahtzeeScored();
    card = refApplyScore(card, Category.Fours, toRefDice([4, 4, 1, 2, 3]));
    assert.equal(outcomeOf(card, Category.Fours, yahtzeeOf(4)).validPlacement, false);
  });

  it('a yahtzee with the yahtzee box OPEN is not a joker: it may go anywhere open', () => {
    const card = refEmptyScorecard();
    const chance = outcomeOf(card, Category.Chance, yahtzeeOf(4));
    assert.equal(chance.validPlacement, true);
    assert.equal(Number(chance.score), 20);
    assert.equal(chance.bonusEarned, false, 'no bonus until the Yahtzee box holds 50');
  });
});

// ---------------------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------------------

describe('totals match api/src/rules.ts', () => {
  it('upperTotal and grandTotal agree over the corpus', () => {
    for (const { card } of makeCorpus()) {
      const c = toCircuitCard(card);
      assert.equal(Number(scoringPure.upperTotal(c.scores)), refUpperTotal(card));
      assert.equal(Number(scoringPure.grandTotal(c.scores, c.yahtzeeBonuses)), refGrandTotal(card));
    }
  });

  it('awards the upper bonus at exactly 63 and not at 62', () => {
    const build = (onesDice: number[]): RefScorecard => {
      let card = refEmptyScorecard();
      card = refApplyScore(card, Category.Ones, toRefDice(onesDice));
      card = refApplyScore(card, Category.Twos, toRefDice([2, 2, 2, 1, 3]));
      card = refApplyScore(card, Category.Threes, toRefDice([3, 3, 3, 1, 2]));
      card = refApplyScore(card, Category.Fours, toRefDice([4, 4, 4, 1, 2]));
      card = refApplyScore(card, Category.Fives, toRefDice([5, 5, 5, 1, 2]));
      card = refApplyScore(card, Category.Sixes, toRefDice([6, 6, 6, 1, 2]));
      return card;
    };

    const at63 = toCircuitCard(build([1, 1, 1, 2, 3]));
    assert.equal(Number(scoringPure.upperTotal(at63.scores)), 63);
    assert.equal(Number(scoringPure.upperBonus(at63.scores)), UPPER_BONUS);
    assert.equal(Number(scoringPure.grandTotal(at63.scores, 0n)), 63 + UPPER_BONUS);

    const at62 = toCircuitCard(build([1, 1, 2, 2, 3]));
    assert.equal(Number(scoringPure.upperTotal(at62.scores)), 62);
    assert.equal(Number(scoringPure.upperBonus(at62.scores)), 0);
    assert.equal(Number(scoringPure.grandTotal(at62.scores, 0n)), 62);
  });

  it('isComplete is true only for a card with all 13 boxes taken', () => {
    const empty = scoringPure.emptyScorecard();
    assert.equal(scoringPure.isComplete(empty), false);
    const full: Scorecard = {
      scores: empty.scores,
      filled: empty.filled.map(() => true),
      yahtzeeBonuses: 0n,
    };
    assert.equal(scoringPure.isComplete(full), true);
    for (let i = 0; i < CATEGORY_COUNT; i++) {
      const oneOpen: Scorecard = {
        scores: full.scores,
        filled: full.filled.map((_, j) => j !== i),
        yahtzeeBonuses: 0n,
      };
      assert.equal(scoringPure.isComplete(oneOpen), false, `box ${i} open but isComplete true`);
    }
  });

  it('emptyScorecard matches the reference empty card', () => {
    assert.ok(cardsEqual(scoringPure.emptyScorecard(), toCircuitCard(refEmptyScorecard())));
  });
});

// ---------------------------------------------------------------------------------------
// Winner and tie-break
// ---------------------------------------------------------------------------------------

describe('winner tie-break matches api/src/rules.ts', () => {
  const NO_FINISH = Number(scoringPure.noFinish());

  /** Pad to six seats. Inactive seats get numbers a naive circuit would let win. */
  const pad6 = (v: readonly number[], fill: number): bigint[] =>
    Array.from({ length: 6 }, (_, i) => BigInt(v[i] ?? fill));

  const circuitWinner = (totals: readonly number[], fins: readonly number[]): number =>
    Number(
      scoringPure.winnerOfSeats(pad6(totals, 65535), pad6(fins, NO_FINISH), BigInt(totals.length)),
    );

  it('the three cases from api/src/rules.test.ts', () => {
    assert.equal(circuitWinner([100, 250, 200], [5, 6, 7]), 1);
    assert.equal(circuitWinner([250, 250, 200], [8, 6, 7]), 1);
    assert.equal(circuitWinner([250, 250], [6, 6]), 0);
  });

  it('agrees with the reference on 4 000 random tables, seat counts 2..6', () => {
    const rng = makeRng('yahtzee-winner');
    let ties = 0;
    let doubleTies = 0;
    for (let i = 0; i < 4_000; i++) {
      const seats = 2 + below(rng, 5);
      // Small ranges on purpose: wide random totals almost never tie, and the tie-break is
      // the part worth testing.
      const totals = Array.from({ length: seats }, () => below(rng, 6) * 50);
      const fins = Array.from({ length: seats }, () => 70 + below(rng, 4));
      const expected = refWinnerSeat(totals, fins);
      assert.equal(
        circuitWinner(totals, fins),
        expected,
        `winner disagrees: totals ${totals.join(',')} fins ${fins.join(',')}`,
      );
      const best = Math.max(...totals);
      if (totals.filter((t) => t === best).length > 1) ties++;
      const tied = totals.map((t, s) => [t, fins[s]!] as const).filter(([t]) => t === best);
      if (tied.length > 1 && new Set(tied.map(([, f]) => f)).size < tied.length) doubleTies++;
    }
    assert.ok(ties > 500, `only ${ties} total-ties in the sample; tie-break barely exercised`);
    assert.ok(doubleTies > 100, `only ${doubleTies} full ties; seat tie-break barely exercised`);
  });

  it('a forfeited seat (noFinish) loses a tie to a seat that finished', () => {
    assert.equal(circuitWinner([250, 250], [NO_FINISH, 70]), 1);
    assert.equal(circuitWinner([250, 250], [70, NO_FINISH]), 0);
  });

  it('seats beyond seatCount cannot win however good their numbers', () => {
    // Seats 2..5 are padded with the maximum total; a 2-seat table must ignore them.
    for (let seats = 2; seats <= 6; seats++) {
      const totals = Array.from({ length: 6 }, (_, i) => (i < seats ? 10 * (i + 1) : 65535));
      const fins = Array.from({ length: 6 }, () => 70);
      const winner = Number(
        scoringPure.winnerOfSeats(totals.map(BigInt), fins.map(BigInt), BigInt(seats)),
      );
      assert.equal(winner, seats - 1, `seatCount ${seats}`);
    }
  });

  it('maxSeats is 6, matching the padding this project uses everywhere', () => {
    assert.equal(Number(scoringPure.maxSeats()), 6);
  });
});

// ---------------------------------------------------------------------------------------
// Rake
// ---------------------------------------------------------------------------------------

describe('rake split matches api/src/rules.ts splitPot', () => {
  const TIERS = [100n, 1_000n, 10_000n, 100_000n];

  it('every tier x seat count 2..6', () => {
    for (const tier of TIERS) {
      for (let seats = 2n; seats <= 6n; seats++) {
        const pot = tier * seats;
        const { winnerPayout, rake } = refSplitPot(pot);
        const q = pot / 100n;
        const r = pot % 100n;
        assert.equal(scoringPure.rakeIsValid(pot, q, r), true, `pot ${pot}`);
        const split = scoringPure.splitPot(pot, q, r);
        assert.equal(split[0], winnerPayout, `winner payout at pot ${pot}`);
        assert.equal(split[1], rake, `rake at pot ${pot}`);
        assert.equal(split[0]! + split[1]!, pot, `split must be conservative at pot ${pot}`);
      }
    }
  });

  it('boundary pots: 0, 99, 100, 101, 199, and the remainder always goes to the winner', () => {
    for (const pot of [0n, 1n, 99n, 100n, 101n, 199n, 200n, 9_999n, 10_000n]) {
      const q = pot / 100n;
      const r = pot % 100n;
      const split = scoringPure.splitPot(pot, q, r);
      const { winnerPayout, rake } = refSplitPot(pot);
      assert.equal(split[0], winnerPayout, `pot ${pot}`);
      assert.equal(split[1], rake, `pot ${pot}`);
      assert.equal(split[0]! + split[1]!, pot);
    }
  });

  it('rejects any (q, r) but the true quotient and remainder', () => {
    // The whole security argument for a supplied quotient: the identity pins it uniquely, so
    // an operator cannot inflate the rake. Both failure modes are checked.
    const pot = 12_345n;
    assert.equal(scoringPure.rakeIsValid(pot, 123n, 45n), true);
    assert.equal(scoringPure.rakeIsValid(pot, 124n, 45n), false, 'inflated quotient');
    assert.equal(scoringPure.rakeIsValid(pot, 122n, 145n), false, 'r >= 100');
    assert.equal(scoringPure.rakeIsValid(pot, 0n, 12_345n), false, 'all remainder');
    assert.throws(() => scoringPure.splitPot(pot, 124n, 45n), /rake split/);
    assert.throws(() => scoringPure.splitPot(pot, 122n, 145n), /rake split/);
  });

  it('agrees with the reference on 2 000 random pots', () => {
    const rng = makeRng('yahtzee-rake');
    for (let i = 0; i < 2_000; i++) {
      let pot = 0n;
      for (let b = 0; b < 5; b++) pot = pot * 256n + BigInt(rng());
      const q = pot / 100n;
      const r = pot % 100n;
      const split = scoringPure.splitPot(pot, q, r);
      const { winnerPayout, rake } = refSplitPot(pot);
      assert.equal(split[0], winnerPayout, `pot ${pot}`);
      assert.equal(split[1], rake, `pot ${pot}`);
    }
  });
});

// ---------------------------------------------------------------------------------------
// The impure circuits, against a ledger
// ---------------------------------------------------------------------------------------

describe('scoreTurn executes against a ledger', () => {
  it('plays a full 13-turn game and tracks the reference engine box for box', () => {
    return (async () => {
      const sim = await ScoringSimulator.create(createDicePrivateState(new Uint8Array(32)));
      const rng = makeRng('yahtzee-game');
      let card = refEmptyScorecard();
      const order = [
        Category.Ones,
        Category.Twos,
        Category.Threes,
        Category.Fours,
        Category.Fives,
        Category.Sixes,
        Category.Yahtzee,
        Category.ThreeOfAKind,
        Category.FourOfAKind,
        Category.FullHouse,
        Category.SmallStraight,
        Category.LargeStraight,
        Category.Chance,
      ];

      for (const cat of order) {
        const dice = Array.from({ length: 5 }, () => 1 + below(rng, 6));
        const outcome = await sim.scoreTurn(BigInt(cat), toCircuitDice(dice));
        card = refApplyScore(card, cat, toRefDice(dice));
        assert.equal(Number(outcome.score), card.scores[cat], `score for ${Category[cat]}`);
        assert.ok(
          cardsEqual(sim.getLedger().card, toCircuitCard(card)),
          `ledger card diverged at ${Category[cat]}`,
        );
        assert.equal(Number(sim.getLedger().lastTotal), refGrandTotal(card));
      }
      assert.equal(scoringPure.isComplete(sim.getLedger().card), true);
    })();
  });

  it('rejects a second write to the same category', async () => {
    const sim = await ScoringSimulator.create(createDicePrivateState(new Uint8Array(32)));
    await sim.scoreTurn(BigInt(Category.Chance), toCircuitDice([1, 1, 1, 1, 2]));
    await assert.rejects(
      () => sim.scoreTurn(BigInt(Category.Chance), toCircuitDice([2, 2, 2, 2, 2])),
      /illegal placement/,
    );
  });

  it('rejects a die outside 1..6', async () => {
    const sim = await ScoringSimulator.create(createDicePrivateState(new Uint8Array(32)));
    await assert.rejects(
      () => sim.scoreTurn(BigInt(Category.Chance), toCircuitDice([0, 1, 2, 3, 4])),
      /die 0 out of range/,
    );
    await assert.rejects(
      () => sim.scoreTurn(BigInt(Category.Chance), toCircuitDice([1, 2, 3, 4, 7])),
      /die 4 out of range/,
    );
  });

  it('enforces the joker forcing rule on-chain', async () => {
    const sim = await ScoringSimulator.create(createDicePrivateState(new Uint8Array(32)));
    const card = refApplyScore(refEmptyScorecard(), Category.Yahtzee, toRefDice([3, 3, 3, 3, 3]));
    await sim.loadCard(toCircuitCard(card));
    await assert.rejects(
      () => sim.scoreTurn(BigInt(Category.Chance), toCircuitDice([4, 4, 4, 4, 4])),
      /illegal placement/,
    );
    const ok = await sim.scoreTurn(BigInt(Category.Fours), toCircuitDice([4, 4, 4, 4, 4]));
    assert.equal(Number(ok.score), 20);
    assert.equal(ok.bonusEarned, true);
    assert.equal(Number(sim.getLedger().card.yahtzeeBonuses), 1);
    assert.equal(Number(sim.getLedger().lastTotal), 50 + 20 + YAHTZEE_BONUS);
  });

  it('settleTable returns the winner and the split, and rejects a bad rake', async () => {
    const sim = await ScoringSimulator.create(createDicePrivateState(new Uint8Array(32)));
    const totals = [200n, 350n, 350n, 0n, 0n, 0n];
    const fins = [70n, 75n, 72n, 0n, 0n, 0n];
    const [winner, payout, rake] = await sim.settleTable(totals, fins, 3n, 30_000n, 300n, 0n);
    assert.equal(Number(winner), 2, 'seat 2 ties on total and finished earlier');
    assert.equal(payout, 29_700n);
    assert.equal(rake, 300n);
    assert.equal(Number(sim.getLedger().lastWinnerSeat), 2);

    await assert.rejects(() => sim.settleTable(totals, fins, 3n, 30_000n, 400n, 0n), /rake split/);
    await assert.rejects(() => sim.settleTable(totals, fins, 1n, 100n, 1n, 0n), /seat count/);
    await assert.rejects(() => sim.settleTable(totals, fins, 7n, 100n, 1n, 0n), /seat count/);
  });
});

// ---------------------------------------------------------------------------------------
// takeTurn: the combined circuit
// ---------------------------------------------------------------------------------------

describe('takeTurn combines the dice and the scoring', () => {
  const TABLE = new Uint8Array(32).fill(0x11);
  const SEED = new Uint8Array(32).fill(0x22);
  const ENTROPY = new Uint8Array(32).fill(0x33);

  /**
   * The load-bearing check on the copied hold policy.
   *
   * takeTurn.compact holds a verbatim copy of turn.compact's policy block (minus the modal
   * branch, which the compiler cannot take -- see that file's header). `resolveTurnTs` in
   * src/dice-mirror.ts is turn.compact's mirror, so if the copy drifts the dice diverge here.
   */
  it('produces exactly the dice turn.compact would, for both available policies', () => {
    const policies: HoldPolicyValue[] = [HoldPolicy.keepNone, HoldPolicy.keepGe4];
    for (const policy of policies) {
      for (let round = 0; round < 13; round++) {
        const dice = takeTurnPure
          .finalDice(TABLE, SEED, ENTROPY, BigInt(round), policy)
          .map(Number);
        const mirror = resolveTurnTs(TABLE, SEED, ENTROPY, round, policy);
        assert.deepEqual(dice, mirror.roll2, `policy ${policy}, round ${round}`);
      }
    }
  });

  it('scores the derived dice exactly as the reference engine would', async () => {
    const sim = await TakeTurnSimulator.create(createDicePrivateState(SEED));
    let card = refEmptyScorecard();
    // Score into Chance every round the box allows, then walk the rest; the point is that
    // the dice come from the circuit and the score is checked against rules.ts.
    const order = [
      Category.Chance,
      Category.Ones,
      Category.Twos,
      Category.Threes,
      Category.Fours,
      Category.Fives,
      Category.Sixes,
      Category.ThreeOfAKind,
      Category.FourOfAKind,
      Category.FullHouse,
      Category.SmallStraight,
      Category.LargeStraight,
      Category.Yahtzee,
    ];

    for (let round = 0; round < order.length; round++) {
      const cat = order[round]!;
      const outcome = await sim.takeTurn(
        TABLE,
        ENTROPY,
        BigInt(round),
        HoldPolicy.keepGe4,
        BigInt(cat),
      );
      const dice = diceToArray(outcome.dice);
      assert.deepEqual(
        dice,
        resolveTurnTs(TABLE, SEED, ENTROPY, round, HoldPolicy.keepGe4).roll2,
        `dice at round ${round}`,
      );
      card = refApplyScore(card, cat, toRefDice(dice));
      assert.equal(Number(outcome.score), card.scores[cat], `score at round ${round}`);
      assert.equal(Number(outcome.total), refGrandTotal(card), `total at round ${round}`);
      assert.ok(
        cardsEqual(sim.getLedger().card, toCircuitCard(card)),
        `ledger card diverged at round ${round}`,
      );
      assert.deepEqual(diceToArray(sim.getLedger().lastDice), dice);
    }
    assert.equal(scoringPure.isComplete(sim.getLedger().card), true);
  });

  it('rejects keepModalFace, which the compiler cannot express here', async () => {
    const sim = await TakeTurnSimulator.create(createDicePrivateState(SEED));
    await assert.rejects(
      () => sim.takeTurn(TABLE, ENTROPY, 0n, HoldPolicy.keepModalFace, BigInt(Category.Chance)),
      /keepModalFace is not available/,
    );
  });

  it('rejects an illegal placement', async () => {
    const sim = await TakeTurnSimulator.create(createDicePrivateState(SEED));
    await sim.takeTurn(TABLE, ENTROPY, 0n, HoldPolicy.keepNone, BigInt(Category.Chance));
    await assert.rejects(
      () => sim.takeTurn(TABLE, ENTROPY, 1n, HoldPolicy.keepNone, BigInt(Category.Chance)),
      /illegal placement/,
    );
  });

  it('agrees with scoring.compact: same dice and card, same outcome', async () => {
    // The two contracts share scoring-core.compact, so this is a check that the shared
    // include really is shared and that takeTurn's missing dice-range assert changes nothing.
    const combined = await TakeTurnSimulator.create(createDicePrivateState(SEED));
    const standalone = await ScoringSimulator.create(createDicePrivateState(SEED));
    for (let round = 0; round < 6; round++) {
      const cat = round as Category;
      const viaCombined = await combined.takeTurn(
        TABLE,
        ENTROPY,
        BigInt(round),
        HoldPolicy.keepGe4,
        BigInt(cat),
      );
      const dice = diceToArray(viaCombined.dice);
      const viaStandalone = await standalone.scoreTurn(BigInt(cat), toCircuitDice(dice));
      assert.equal(Number(viaCombined.score), Number(viaStandalone.score), `round ${round}`);
      assert.equal(viaCombined.bonusEarned, viaStandalone.bonusEarned);
      assert.ok(cardsEqual(combined.getLedger().card, standalone.getLedger().card));
      assert.equal(Number(viaCombined.total), Number(standalone.getLedger().lastTotal));
    }
  });
});
