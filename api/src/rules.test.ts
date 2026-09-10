import { describe, expect, it } from 'vitest';
import {
  applyScore,
  Category,
  type Dice,
  emptyScorecard,
  grandTotal,
  isFiveOfAKind,
  rawScore,
  RuleViolation,
  type Scorecard,
  splitPot,
  upperTotal,
  UPPER_BONUS,
  winnerSeat,
} from './rules.js';

const d = (...v: number[]) => v as unknown as Dice;

describe('rawScore', () => {
  it('scores upper categories by face count', () => {
    expect(rawScore(Category.Ones, d(1, 1, 3, 4, 5))).toBe(2);
    expect(rawScore(Category.Sixes, d(6, 6, 6, 2, 1))).toBe(18);
    expect(rawScore(Category.Fours, d(1, 2, 3, 5, 6))).toBe(0);
  });

  it('three/four of a kind score dice sum, else 0', () => {
    expect(rawScore(Category.ThreeOfAKind, d(3, 3, 3, 4, 5))).toBe(18);
    expect(rawScore(Category.ThreeOfAKind, d(3, 3, 4, 4, 5))).toBe(0);
    expect(rawScore(Category.FourOfAKind, d(2, 2, 2, 2, 6))).toBe(14);
    expect(rawScore(Category.FourOfAKind, d(2, 2, 2, 6, 6))).toBe(0);
    // five of a kind satisfies both
    expect(rawScore(Category.FourOfAKind, d(5, 5, 5, 5, 5))).toBe(25);
  });

  it('full house = 25, and a five of a kind counts as a full house', () => {
    expect(rawScore(Category.FullHouse, d(2, 2, 3, 3, 3))).toBe(25);
    expect(rawScore(Category.FullHouse, d(2, 2, 3, 3, 4))).toBe(0);
    expect(rawScore(Category.FullHouse, d(4, 4, 4, 4, 4))).toBe(25);
  });

  it('straights', () => {
    expect(rawScore(Category.SmallStraight, d(1, 2, 3, 4, 6))).toBe(30);
    expect(rawScore(Category.SmallStraight, d(2, 3, 4, 5, 5))).toBe(30);
    expect(rawScore(Category.SmallStraight, d(1, 2, 3, 5, 6))).toBe(0);
    expect(rawScore(Category.LargeStraight, d(1, 2, 3, 4, 5))).toBe(40);
    expect(rawScore(Category.LargeStraight, d(2, 3, 4, 5, 6))).toBe(40);
    expect(rawScore(Category.LargeStraight, d(1, 2, 3, 4, 6))).toBe(0);
  });

  it('five of a kind and chance', () => {
    expect(rawScore(Category.FiveOfAKind, d(6, 6, 6, 6, 6))).toBe(50);
    expect(rawScore(Category.FiveOfAKind, d(6, 6, 6, 6, 5))).toBe(0);
    expect(rawScore(Category.Chance, d(1, 2, 3, 4, 5))).toBe(15);
  });
});

describe('applyScore + totals', () => {
  it('rejects double-filling a category', () => {
    const card = applyScore(emptyScorecard(), Category.Chance, d(1, 1, 1, 1, 2));
    expect(() => applyScore(card, Category.Chance, d(2, 2, 2, 2, 2))).toThrow(RuleViolation);
  });

  it('awards the upper bonus at exactly 63', () => {
    let card = emptyScorecard();
    // three of each face = 63
    card = applyScore(card, Category.Ones, d(1, 1, 1, 2, 3));
    card = applyScore(card, Category.Twos, d(2, 2, 2, 1, 3));
    card = applyScore(card, Category.Threes, d(3, 3, 3, 1, 2));
    card = applyScore(card, Category.Fours, d(4, 4, 4, 1, 2));
    card = applyScore(card, Category.Fives, d(5, 5, 5, 1, 2));
    card = applyScore(card, Category.Sixes, d(6, 6, 6, 1, 2));
    expect(upperTotal(card)).toBe(63);
    expect(grandTotal(card)).toBe(63 + UPPER_BONUS);
  });

  it('no upper bonus at 62', () => {
    let card = emptyScorecard();
    card = applyScore(card, Category.Ones, d(1, 1, 2, 2, 3)); // 2
    card = applyScore(card, Category.Twos, d(2, 2, 2, 1, 3));
    card = applyScore(card, Category.Threes, d(3, 3, 3, 1, 2));
    card = applyScore(card, Category.Fours, d(4, 4, 4, 1, 2));
    card = applyScore(card, Category.Fives, d(5, 5, 5, 1, 2));
    card = applyScore(card, Category.Sixes, d(6, 6, 6, 1, 2));
    expect(upperTotal(card)).toBe(62);
    expect(grandTotal(card)).toBe(62);
  });
});

describe('five-of-a-kind joker rules', () => {
  const fiveOfAKindOf = (face: number) => d(face, face, face, face, face);

  const withFiveOfAKindScored = (): Scorecard =>
    applyScore(emptyScorecard(), Category.FiveOfAKind, fiveOfAKindOf(3));

  it('an extra five of a kind forces the open matching upper box and pays the bonus', () => {
    const card = withFiveOfAKindScored();
    expect(() => applyScore(card, Category.Chance, fiveOfAKindOf(4))).toThrow(RuleViolation);
    const next = applyScore(card, Category.Fours, fiveOfAKindOf(4));
    expect(next.scores[Category.Fours]).toBe(20);
    expect(next.fiveOfAKindBonuses).toBe(1);
    expect(grandTotal(next)).toBe(50 + 20 + 100);
  });

  it('joker full house / straights count in full when upper box is filled', () => {
    let card = withFiveOfAKindScored();
    card = applyScore(card, Category.Fours, d(4, 4, 1, 2, 3)); // fill Fours = 8
    const fh = applyScore(card, Category.FullHouse, fiveOfAKindOf(4));
    expect(fh.scores[Category.FullHouse]).toBe(25);
    expect(fh.fiveOfAKindBonuses).toBe(1);
    const ls = applyScore(card, Category.LargeStraight, fiveOfAKindOf(4));
    expect(ls.scores[Category.LargeStraight]).toBe(40);
  });

  it('scratched Five of a Kind box: joker placement rules apply but no bonus', () => {
    let card = applyScore(emptyScorecard(), Category.FiveOfAKind, d(1, 2, 3, 4, 5)); // 0
    card = applyScore(card, Category.Fours, d(4, 4, 1, 2, 3));
    const next = applyScore(card, Category.FullHouse, fiveOfAKindOf(4));
    expect(next.scores[Category.FullHouse]).toBe(25);
    expect(next.fiveOfAKindBonuses).toBe(0);
  });

  it('upper fallback scores face value when everything else is filled', () => {
    let card = withFiveOfAKindScored();
    // fill Fives and all lower categories
    card = applyScore(card, Category.Fives, d(5, 5, 1, 2, 3));
    for (const cat of [
      Category.ThreeOfAKind,
      Category.FourOfAKind,
      Category.FullHouse,
      Category.SmallStraight,
      Category.LargeStraight,
      Category.Chance,
    ]) {
      card = applyScore(card, cat, d(1, 2, 3, 5, 6));
    }
    const next = applyScore(card, Category.Twos, fiveOfAKindOf(5));
    expect(next.scores[Category.Twos]).toBe(0); // no 2s in a five of a kind of 5s
    expect(next.fiveOfAKindBonuses).toBe(1); // bonus still earned
  });
});

describe('winnerSeat tie-break', () => {
  it('highest total wins', () => {
    expect(winnerSeat([100, 250, 200], [5, 6, 7])).toBe(1);
  });
  it('tie → earliest finisher', () => {
    expect(winnerSeat([250, 250, 200], [8, 6, 7])).toBe(1);
  });
  it('tie on both → lowest seat', () => {
    expect(winnerSeat([250, 250], [6, 6])).toBe(0);
  });
});

describe('splitPot (mirrors circuit witness arithmetic)', () => {
  it('remainder goes to the winner', () => {
    for (const [pot, rake] of [
      [600n, 6n], // 100-tier, 6 seats: no remainder
      [500n, 5n],
      [199n, 1n], // remainder 99 stays with winner
      [100_000n * 6n, 6_000n],
      [99n, 0n], // sub-100 pot: all to winner
    ] as const) {
      const { winnerPayout, rake: r } = splitPot(pot);
      expect(r).toBe(rake);
      expect(winnerPayout + r).toBe(pot);
      expect(r * 100n <= pot).toBe(true);
      expect((r + 1n) * 100n > pot).toBe(true);
    }
  });

  it('every tier × seat-count boundary', () => {
    for (const tier of [100n, 1_000n, 10_000n, 100_000n]) {
      for (let seats = 2n; seats <= 6n; seats++) {
        const pot = tier * seats;
        const { winnerPayout, rake } = splitPot(pot);
        expect(winnerPayout + rake).toBe(pot);
        expect(rake).toBe(pot / 100n);
      }
    }
  });

  it('isFiveOfAKind sanity', () => {
    expect(isFiveOfAKind(d(2, 2, 2, 2, 2))).toBe(true);
    expect(isFiveOfAKind(d(2, 2, 2, 2, 3))).toBe(false);
  });
});
