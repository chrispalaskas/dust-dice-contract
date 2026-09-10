/**
 * Pure Dust Dice rules (the standard Yahtzee rules): scoring, upper bonus, five-of-a-kind bonus with joker rules,
 * and the deterministic tie-break.
 *
 * This module is the single reference implementation of the game's arithmetic.
 * The Compact circuit mirrors it; the browser verifier re-derives games with it.
 * It must stay dependency-free and side-effect-free.
 */

export type Die = 1 | 2 | 3 | 4 | 5 | 6;
export type Dice = readonly [Die, Die, Die, Die, Die];

/**
 * Category indices are contract-canonical: they appear on-chain in scorecards
 * and in takeTurn arguments. Never reorder.
 */
export enum Category {
  Ones = 0,
  Twos = 1,
  Threes = 2,
  Fours = 3,
  Fives = 4,
  Sixes = 5,
  ThreeOfAKind = 6,
  FourOfAKind = 7,
  FullHouse = 8,
  SmallStraight = 9,
  LargeStraight = 10,
  FiveOfAKind = 11,
  Chance = 12,
}

export const CATEGORY_COUNT = 13;
export const UPPER_BONUS_THRESHOLD = 63;
export const UPPER_BONUS = 35;
export const FIVE_OF_A_KIND_BONUS = 100;

const counts = (dice: Dice): number[] => {
  const c = [0, 0, 0, 0, 0, 0, 0]; // index 1..6 used
  for (const d of dice) c[d]++;
  return c;
};

const sum = (dice: Dice): number => dice.reduce((a, b) => a + b, 0);

export const isFiveOfAKind = (dice: Dice): boolean => counts(dice).some((n) => n === 5);

/**
 * Face-value score of `dice` in `category`, with no joker considerations.
 */
export function rawScore(category: Category, dice: Dice): number {
  const c = counts(dice);
  switch (category) {
    case Category.Ones:
    case Category.Twos:
    case Category.Threes:
    case Category.Fours:
    case Category.Fives:
    case Category.Sixes: {
      const face = category + 1;
      return c[face] * face;
    }
    case Category.ThreeOfAKind:
      return c.some((n) => n >= 3) ? sum(dice) : 0;
    case Category.FourOfAKind:
      return c.some((n) => n >= 4) ? sum(dice) : 0;
    case Category.FullHouse:
      return (c.includes(3) && c.includes(2)) || c.includes(5) ? 25 : 0;
    case Category.SmallStraight: {
      const has = (f: number) => c[f] > 0;
      return (has(1) && has(2) && has(3) && has(4)) ||
        (has(2) && has(3) && has(4) && has(5)) ||
        (has(3) && has(4) && has(5) && has(6))
        ? 30
        : 0;
    }
    case Category.LargeStraight: {
      const has = (f: number) => c[f] > 0;
      return (has(1) && has(2) && has(3) && has(4) && has(5)) ||
        (has(2) && has(3) && has(4) && has(5) && has(6))
        ? 40
        : 0;
    }
    case Category.FiveOfAKind:
      return isFiveOfAKind(dice) ? 50 : 0;
    case Category.Chance:
      return sum(dice);
  }
}

export interface Scorecard {
  /** score per category, null = unfilled */
  readonly scores: ReadonlyArray<number | null>;
  readonly fiveOfAKindBonuses: number;
}

export const emptyScorecard = (): Scorecard => ({
  scores: Array(CATEGORY_COUNT).fill(null),
  fiveOfAKindBonuses: 0,
});

export class RuleViolation extends Error {}

/**
 * Apply the final dice of a turn to `card` in `category`, enforcing official
 * joker rules for extra fives of a kind:
 *
 * - An extra five of a kind (Five of a Kind box already scored 50) earns a +100 bonus and the
 *   dice must be placed in the matching upper category if it is open; if it is
 *   filled, any lower category may be taken at its full (joker) value; if all
 *   lower boxes are filled too, an open upper category is taken at face value.
 * - If the Five of a Kind box was scored 0 (scratched), later fives of a kind earn no bonus
 *   but the same forced-placement rules apply.
 */
export function applyScore(card: Scorecard, category: Category, dice: Dice): Scorecard {
  if (card.scores[category] !== null) {
    throw new RuleViolation(`category ${Category[category]} already filled`);
  }

  const fiveOfAKind = isFiveOfAKind(dice);
  const fiveOfAKindBoxFilled = card.scores[Category.FiveOfAKind] !== null;
  let bonus = 0;
  let score: number;

  if (fiveOfAKind && fiveOfAKindBoxFilled) {
    // Joker situation.
    if (card.scores[Category.FiveOfAKind] === 50) bonus = FIVE_OF_A_KIND_BONUS;
    const face = dice[0];
    const upperCat = (face - 1) as Category;
    const lowerOpen = [
      Category.ThreeOfAKind,
      Category.FourOfAKind,
      Category.FullHouse,
      Category.SmallStraight,
      Category.LargeStraight,
      Category.Chance,
    ].filter((cat) => card.scores[cat] === null);

    if (card.scores[upperCat] === null) {
      if (category !== upperCat) {
        throw new RuleViolation(
          `joker rules: must score in ${Category[upperCat]} while it is open`,
        );
      }
      score = rawScore(category, dice);
    } else if (lowerOpen.length > 0) {
      if (!lowerOpen.includes(category)) {
        throw new RuleViolation(`joker rules: must score in an open lower category`);
      }
      // Joker value: straights and full house count in full.
      score =
        category === Category.FullHouse
          ? 25
          : category === Category.SmallStraight
            ? 30
            : category === Category.LargeStraight
              ? 40
              : rawScore(category, dice);
    } else {
      // Only upper categories remain; face value (which is 0 unless it matches).
      score = rawScore(category, dice);
    }
  } else {
    score = rawScore(category, dice);
  }

  const scores = card.scores.slice();
  scores[category] = score;
  return { scores, fiveOfAKindBonuses: card.fiveOfAKindBonuses + (bonus > 0 ? 1 : 0) };
}

export function upperTotal(card: Scorecard): number {
  let t = 0;
  for (let cat = Category.Ones; cat <= Category.Sixes; cat++) t += card.scores[cat] ?? 0;
  return t;
}

export function grandTotal(card: Scorecard): number {
  const filled = card.scores.reduce((a: number, s) => a + (s ?? 0), 0);
  const upperBonus = upperTotal(card) >= UPPER_BONUS_THRESHOLD ? UPPER_BONUS : 0;
  return filled + upperBonus + card.fiveOfAKindBonuses * FIVE_OF_A_KIND_BONUS;
}

export const isComplete = (card: Scorecard): boolean => card.scores.every((s) => s !== null);

/**
 * Deterministic winner selection — no pot splitting on Midnight (no division
 * in-circuit), so ties break deterministically. Stated in the site rules.
 *
 * @param totals grand total per seat
 * @param finishedAtTurn global turn index at which each seat completed its 13th
 *   category (lower = earlier); forfeited seats carry Infinity and a total
 *   computed from what they finished.
 * @returns winning seat index: highest total; tie → earliest finisher; tie →
 *   lowest seat index.
 */
export function winnerSeat(totals: readonly number[], finishedAtTurn: readonly number[]): number {
  if (totals.length === 0) throw new RuleViolation('no seats');
  let win = 0;
  for (let seat = 1; seat < totals.length; seat++) {
    if (
      totals[seat] > totals[win] ||
      (totals[seat] === totals[win] && finishedAtTurn[seat] < finishedAtTurn[win])
    ) {
      win = seat;
    }
  }
  return win;
}

/**
 * Rake split, mirroring the circuit's witness-checked arithmetic:
 * the circuit asserts q * 100 + r == pot && r < 100; the remainder goes to the
 * winner. rake = q (1% rounded down), winnerPayout = pot - q.
 */
export function splitPot(pot: bigint): { winnerPayout: bigint; rake: bigint } {
  const q = pot / 100n;
  return { winnerPayout: pot - q, rake: q };
}
